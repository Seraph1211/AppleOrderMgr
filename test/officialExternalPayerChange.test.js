/* eslint-disable camelcase -- 对照PostgreSQL原始JSON字段，不改外部schema。 */
/* eslint-disable no-magic-numbers -- 固定异常目标及隔离数据库边界。 */
const { Client } = require('pg');
const {
  verifyExternalPayerRecord,
  buildExternalPayerBasis,
} = require('../scripts/officialPickupBackfill/verifyExternalPayerChange');

const integration =
  process.env.PICKUP_TEST_DB_HOST === 'official-order-rebuild-postgres' ? describe : describe.skip;
integration('真实隔离PostgreSQL：付款变更附加基线', () => {
  let client;
  let record;
  beforeEach(async () => {
    client = new Client({
      host: process.env.PICKUP_TEST_DB_HOST,
      user: 'postgres',
      password: 'test-only',
      database: 'postgres',
    });
    await client.connect();
    await client.query("SET TIME ZONE 'Asia/Shanghai'");
    await client.query(`CREATE TEMP TABLE orders(id integer,order_number text,email_order_status text,
      payer_name text,payer_version integer,updated_at timestamptz,actual_pickup_date date,
      official_raw_status text,official_status_observed_at timestamptz,amount numeric(12,2),notes text);
      CREATE TEMP TABLE pickup_devices(id integer,order_id integer);
      CREATE TEMP TABLE order_payer_events(id integer,order_id integer,before_version integer,
        after_version integer,new_payer_name text);
      INSERT INTO orders VALUES(1113,'W1234567890','picked_up','old',0,'2026-10-01',null,null,null,123.00,'keep');
      INSERT INTO order_payer_events VALUES(1,1113,0,1,'new')`);
    const before = await client.query(
      "SELECT md5((to_jsonb(o)-'actual_pickup_date')::text) AS hash,to_jsonb(o) AS snapshot FROM orders o"
    );
    await client.query(
      "UPDATE orders SET payer_name='new',payer_version=1,updated_at='2026-10-08'"
    );
    const after = await client.query(`SELECT to_jsonb(o) AS snapshot,md5(to_jsonb(o)::text) AS hash,
      md5((to_jsonb(o)-'actual_pickup_date')::text) AS original,
      md5((to_jsonb(o)-ARRAY['actual_pickup_date','official_raw_status','official_status_observed_at'])::text) AS stable
      FROM orders o`);
    const event = await client.query('SELECT to_jsonb(e) AS value FROM order_payer_events e');
    record = {
      id: 1113,
      entry: { id: 1113, orderNumber: 'W1234567890', rowHash: before.rows[0].hash },
      kind: 'ORIGINAL',
      beforeHash: before.rows[0].hash,
      beforePayer: {
        payer_name: 'old',
        payer_version: 0,
        updated_at: before.rows[0].snapshot.updated_at,
      },
      acceptedSnapshot: after.rows[0].snapshot,
      acceptedFullHash: after.rows[0].hash,
      acceptedOriginalHash: after.rows[0].original,
      acceptedStableHash: after.rows[0].stable,
      devices: [],
      payerEvent: event.rows[0].value,
    };
  });
  afterEach(async () => {
    await client.end();
  });
  test('只认付款三字段变化，保留numeric小数位', async () => {
    await expect(verifyExternalPayerRecord(client, record)).resolves.toBe(true);
  });
  test.each([
    "UPDATE orders SET notes='changed'",
    "UPDATE orders SET payer_name='unexpected'",
    'UPDATE orders SET payer_version=2',
    "UPDATE orders SET updated_at='2026-10-09'",
    "UPDATE orders SET order_number='W9999999999'",
    "UPDATE orders SET email_order_status='cancelled'",
    'INSERT INTO pickup_devices VALUES(1,1113)',
    'DELETE FROM order_payer_events',
    "UPDATE order_payer_events SET new_payer_name='altered'",
    "INSERT INTO order_payer_events VALUES(2,1113,1,2,'another')",
  ])('拒绝额外变化：%s', async sql => {
    await client.query(sql);
    await expect(verifyExternalPayerRecord(client, record)).rejects.toMatchObject({
      code: 'HTTP_APPLY_PAYER_CHANGE_INVALID',
    });
  });
  test('只读回放允许另经HTTP完整链核验的状态日期变化，采样前不允许', async () => {
    await client.query(
      "UPDATE orders SET actual_pickup_date='2026-09-29',official_raw_status='PICKED_UP'"
    );
    await expect(verifyExternalPayerRecord(client, record)).rejects.toThrow();
    await expect(verifyExternalPayerRecord(client, record, true)).resolves.toBe(true);
  });
  test('错误原hash不能被固定当前快照掩盖', async () => {
    record.beforeHash = 'a'.repeat(32);
    await expect(verifyExternalPayerRecord(client, record)).rejects.toThrow();
  });
  test.each([220, 300, 301, 806, 1114])('AFTER_HTTP %i 必须核验原写后整行且不能接受新HTTP变化', async orderId => {
    await client.query(`UPDATE orders SET id=${orderId}; UPDATE order_payer_events SET order_id=${orderId}`);
    record.id = orderId;
    record.entry.id = orderId;
    record.kind = 'AFTER_HTTP';
    record.acceptedSnapshot.id = orderId;
    record.payerEvent.order_id = orderId;
    const { rows } = await client.query(`SELECT md5(to_jsonb(o)::text) AS hash,
      md5((to_jsonb(o)-'actual_pickup_date')::text) AS original,
      md5((to_jsonb(o)-ARRAY['actual_pickup_date','official_raw_status','official_status_observed_at'])::text) AS stable,
      md5((to_jsonb(o)||jsonb_build_object('payer_name','old','payer_version',0,'updated_at','2026-10-01'::timestamptz))::text) AS before
      FROM orders o`);
    Object.assign(record, {
      acceptedFullHash: rows[0].hash,
      acceptedOriginalHash: rows[0].original,
      acceptedStableHash: rows[0].stable,
      beforeHash: rows[0].before,
    });
    await expect(verifyExternalPayerRecord(client, record)).resolves.toBe(true);
    await expect(verifyExternalPayerRecord(client, record, true)).rejects.toThrow();
  });
  test('真实HTTP事务仅填官网字段，完整保留新付款人及更新时间', async () => {
    const { applyHttpPayload } = require('../scripts/officialPickupBackfill/applyHttpResult');
    const now = Date.now();
    Object.assign(record.entry, {
      dateMissing: true,
      serialsMissing: true,
      previousDate: null,
      previousDevices: [],
    });
    const payload = {
      version: 1,
      planSha256: 'a'.repeat(64),
      entry: record.entry,
      plan: {
        schemaVersion: 3,
        scope: 'missing-fields',
        cutoff: null,
        startedAt: new Date(now - 3000).toISOString(),
        policy: { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 },
        entries: [record.entry],
      },
      result: {
        systemOrderId: 1113,
        orderNumber: record.entry.orderNumber,
        identityMatched: true,
        sourceModel: 'orderDetail',
        completeItemCount: 1,
        orderPlacedDateText: '2026年9月28日',
        products: [
          {
            name: 'Synthetic device',
            quantity: 1,
            rawStatus: 'PICKED_UP',
            pickupDateText: '已取货9月29日',
          },
        ],
        source: {
          provider: 'Apple official website',
          status: 200,
          cached: false,
          host: 'secure6.www.apple.com.cn',
          sha256: 'b'.repeat(64),
          runId: 2000,
          contentType: 'application/json',
          observedAt: new Date(now - 1000).toISOString(),
        },
      },
      audit: {
        outcome: 'SUCCEEDED',
        orderId: 1113,
        targetOrderId: 1113,
        runId: 2000,
        attemptId: 'c'.repeat(32),
        egressVerifiedAfter: true,
        egressHash: 'd'.repeat(64),
        egressAfterHash: 'd'.repeat(64),
        businessWrites: 0,
        cleanup: { removed: true },
        startedAt: (now - 2000) / 1000,
        finishedAt: now / 1000,
        resultFile: '/research/private/results/order-1113-run-2000.json',
      },
      evidence: {
        bodySha256: 'b'.repeat(64),
        responseSha256: 'e'.repeat(64),
        requestSha256: 'f'.repeat(64),
        auditSha256: '1'.repeat(64),
      },
    };
    await expect(applyHttpPayload(client, payload, { mode: 'dry-run' })).rejects.toMatchObject({
      code: 'HTTP_APPLY_ORDER_CHANGED',
    });
    await verifyExternalPayerRecord(client, record);
    const basis = buildExternalPayerBasis(record, payload);
    const preview = await applyHttpPayload(client, payload, { mode: 'dry-run', basis });
    expect(preview.beforeHash).toBe(record.acceptedFullHash);
    await verifyExternalPayerRecord(client, record);
    const result = await applyHttpPayload(client, payload, { mode: 'apply', basis, preview });
    expect(result.businessWrites).toBe(1);
    const after = await client.query('SELECT to_jsonb(o) AS value FROM orders o');
    expect(after.rows[0].value).toEqual({
      ...record.acceptedSnapshot,
      actual_pickup_date: '2026-09-29',
      official_raw_status: 'PICKED_UP',
      official_status_observed_at: after.rows[0].value.official_status_observed_at,
    });
    await expect(verifyExternalPayerRecord(client, record)).rejects.toThrow();
    await expect(verifyExternalPayerRecord(client, record, true)).resolves.toBe(true);
  });
  test('basis绑定原entry、新run及摘要，不改变原计划', () => {
    const payload = {
      entry: record.entry,
      planSha256: 'a'.repeat(64),
      result: { source: { runId: 2000 } },
      evidence: { auditSha256: 'b'.repeat(64) },
    };
    const basis = buildExternalPayerBasis(record, payload);
    expect(basis.originalRowHash).toBe(record.entry.rowHash);
    expect(basis.stableRowHash).toBe(record.acceptedStableHash);
    expect(buildExternalPayerBasis(record, payload, basis)).toEqual(basis);
    expect(() => buildExternalPayerBasis(record, payload, { ...basis, runId: 1 })).toThrow();
    expect(() =>
      buildExternalPayerBasis(record, { ...payload, entry: { ...record.entry, id: 220 } })
    ).toThrow();
  });
});
