/* eslint-disable no-magic-numbers -- 独立审查：真实 PostgreSQL 时间精度、锁后时效和事务回滚边界。 */
const { Client } = require('pg');
const { applyHttpPayload } = require('../scripts/officialPickupBackfill/applyHttpResult');
const { freezePickupBackfill } = require('../src/services/officialPickupBackfill');
const { parseOfficialOrderDetail } = require('../src/services/officialOrderParser');
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
const { hash } = require('../src/services/officialOrderSupport');

const describeDb =
  process.env.PICKUP_TEST_DB_HOST === 'official-order-rebuild-postgres' ? describe : describe.skip;

describeDb('HTTP回写独立审查：真实数据库保护', () => {
  let client;
  let payload;
  let now;

  beforeAll(async () => {
    client = new Client({
      host: process.env.PICKUP_TEST_DB_HOST,
      user: 'postgres',
      password: 'test-only',
      database: 'postgres',
    });
    await client.connect();
    await client.query(`CREATE TEMP TABLE orders (
      id int PRIMARY KEY, order_number text, apple_id text, email_order_status text,
      email_pickup_date date, actual_pickup_date date, official_raw_status text,
      official_status_observed_at timestamptz, status text,
      updated_at timestamptz DEFAULT '2026-09-22T00:00:00Z')`);
    await client.query(
      'CREATE TEMP TABLE pickup_devices(id int PRIMARY KEY, order_id int, serial_number text)'
    );
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    now = Date.now();
    await client.query('DROP TRIGGER IF EXISTS review_mutation ON orders');
    await client.query('TRUNCATE orders,pickup_devices');
    await client.query(`INSERT INTO orders(id,order_number,apple_id,email_order_status,status)
      VALUES(1,'W1234567890','synthetic@example.test','picked_up','manual')`);
    await refreshPayload();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function refreshPayload() {
    try {
      const plan = await freezePickupBackfill(client, { missingFields: true });
      plan.startedAt = new Date(now - 3000).toISOString();
      const model = buildLifecycleJson('PICKED_UP');
      const body = JSON.stringify(model);
      const source = {
        provider: 'Apple official website',
        status: 200,
        cached: false,
        host: 'secure6.www.apple.com.cn',
        sha256: hash(body),
        runId: 12,
        contentType: 'application/json',
        observedAt: new Date(now - 1000).toISOString(),
      };
      const audit = {
        outcome: 'SUCCEEDED',
        orderId: 1,
        targetOrderId: 1,
        runId: 12,
        attemptId: 'c'.repeat(32),
        startedAt: (now - 2000) / 1000,
        finishedAt: (now - 500) / 1000,
        egressHash: 'd'.repeat(64),
        egressAfterHash: 'd'.repeat(64),
        egressVerifiedAfter: true,
        businessWrites: 0,
        resultFile: '/research/private/results/order-1-run-12.json',
        cleanup: { removed: true },
      };
      payload = {
        version: 1,
        plan,
        planSha256: hash(JSON.stringify(plan)),
        entry: plan.entries[0],
        result: { ...parseOfficialOrderDetail(body, 'W1234567890'), systemOrderId: 1, source },
        audit,
        evidence: {
          bodySha256: source.sha256,
          responseSha256: 'e'.repeat(64),
          requestSha256: 'f'.repeat(64),
          auditSha256: hash(JSON.stringify(audit)),
        },
      };
    } catch (error) {
      error.component = 'officialHttpApplyReviewTest';
      throw error;
    }
  }

  async function dryRun(target = client, basis) {
    try {
      return await applyHttpPayload(target, payload, { mode: 'dry-run', basis });
    } catch (error) {
      error.component = 'officialHttpApplyReviewTest';
      throw error;
    }
  }

  async function apply(preview, target = client) {
    try {
      return await applyHttpPayload(target, payload, {
        mode: 'apply',
        basis: preview.basis,
        preview,
      });
    } catch (error) {
      error.component = 'officialHttpApplyReviewTest';
      throw error;
    }
  }

  test('dry-run使用数据库只读事务、无行锁或DML且完整回滚', async () => {
    const statements = [];
    const target = {
      query: async (sql, values) => {
        try {
          statements.push(sql);
          return await client.query(sql, values);
        } catch (error) {
          error.component = 'officialHttpApplyReviewTest';
          throw error;
        }
      },
    };
    expect((await dryRun(target)).businessWrites).toBe(0);
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(statements.some(sql => /\b(?:UPDATE orders|INSERT|DELETE|FOR UPDATE)\b/.test(sql))).toBe(
      false
    );
    expect(
      (await client.query('SELECT official_raw_status AS status FROM orders')).rows[0].status
    ).toBeNull();
  });

  test('现有官网时间仅晚1微秒也不得覆盖状态或填旧日期', async () => {
    await client.query(
      `UPDATE orders SET official_raw_status='NEWER',
      official_status_observed_at=$1::timestamptz + interval '1 microsecond'`,
      [payload.result.source.observedAt]
    );
    await refreshPayload();
    const preview = await dryRun();
    expect(preview.statusAction).toBe('KEEP_NEWER_STATUS');
    expect((await apply(preview)).businessWrites).toBe(0);
    expect(
      (
        await client.query(
          'SELECT official_raw_status AS status,actual_pickup_date AS date FROM orders'
        )
      ).rows[0]
    ).toEqual({ status: 'NEWER', date: null });
  });

  test('等待FOR UPDATE后超过5分钟立即回滚，不能持旧payload更新', async () => {
    const preview = await dryRun();
    const statements = [];
    const target = {
      query: async (sql, values) => {
        try {
          statements.push(sql);
          const value = await client.query(sql, values);
          if (/FOR UPDATE/.test(sql)) jest.spyOn(Date, 'now').mockReturnValue(now + 300001);
          return value;
        } catch (error) {
          error.component = 'officialHttpApplyReviewTest';
          throw error;
        }
      },
    };
    await expect(apply(preview, target)).rejects.toThrow('HTTP_APPLY_SOURCE_INVALID');
    expect(statements.some(sql => /UPDATE orders/.test(sql))).toBe(false);
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(
      (await client.query('SELECT official_raw_status AS status FROM orders')).rows[0].status
    ).toBeNull();
  });

  test('触发器意外改动非目标字段时后验失败并回滚整个事务', async () => {
    await client.query(`CREATE OR REPLACE FUNCTION pg_temp.review_change_status()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.status := 'unexpected'; RETURN NEW; END $$`);
    await client.query(`CREATE TRIGGER review_mutation BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION pg_temp.review_change_status()`);
    const preview = await dryRun();
    await expect(apply(preview)).rejects.toThrow('HTTP_APPLY_INVARIANCE_FAILED');
    const row = (
      await client.query(
        'SELECT status,official_raw_status AS official,actual_pickup_date AS date FROM orders'
      )
    ).rows[0];
    expect(row).toEqual({ status: 'manual', official: null, date: null });
  });

  test('preview后仅变动1微秒完整行摘要仍拒绝，不能依赖JS Date精度', async () => {
    await client.query('UPDATE orders SET official_status_observed_at=$1::timestamptz', [
      payload.result.source.observedAt,
    ]);
    await refreshPayload();
    const preview = await dryRun();
    await client.query(
      `UPDATE orders SET official_status_observed_at=
        official_status_observed_at+interval '1 microsecond'`
    );
    await expect(apply(preview)).rejects.toThrow('HTTP_APPLY_ORDER_CHANGED');
  });
});
