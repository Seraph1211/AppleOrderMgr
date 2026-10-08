/* eslint-disable no-magic-numbers -- 临时表的真实 PostgreSQL 事务与回读。 */
const { Client } = require('pg');
const {
  preparePickupStatusPlan,
  applyPickupBackfill,
  freezePickupBackfill,
} = require('../src/services/officialPickupBackfill');
const describeDb = ['apple-pickup-opt-1008-db', 'official-order-rebuild-postgres'].includes(
  process.env.PICKUP_TEST_DB_HOST
)
  ? describe
  : describe.skip;
describeDb('限定补录日期和官网状态事务', () => {
  let client;
  let plan;
  let result;
  beforeAll(async () => {
    client = new Client({
      host: process.env.PICKUP_TEST_DB_HOST,
      user: 'postgres',
      password: 'test-only',
      database: 'postgres',
    });
    await client.connect();
    await client.query(`CREATE TEMP TABLE orders (
      id int PRIMARY KEY,order_number text,apple_id text,email_order_status text,email_pickup_date date,
      actual_pickup_date date,official_raw_status text,official_status_observed_at timestamptz,
      status text,updated_at timestamptz DEFAULT '2026-09-22T00:00:00Z')`);
    await client.query(
      'CREATE TEMP TABLE pickup_devices (id int PRIMARY KEY,order_id int,serial_number text,stock_unit_id text)'
    );
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query('TRUNCATE orders,pickup_devices');
    await client.query(`INSERT INTO orders(id,order_number,apple_id,email_order_status,email_pickup_date,status)
      VALUES(1,'W1234567890','a@example.test','picked_up','2026-09-22','manual')`);
    const { rows } =
      await client.query(`SELECT id,order_number AS "orderNumber",md5(apple_id) AS "accountKey",
      md5((to_jsonb(o)-'actual_pickup_date')::text) AS "rowHash" FROM orders o`);
    const startedAt = new Date(Date.now() - 1000).toISOString();
    plan = { startedAt, cutoff: '2026-09-23', entries: rows };
    result = {
      systemOrderId: 1,
      orderNumber: 'W1234567890',
      identityMatched: true,
      sourceModel: 'orderDetail',
      completeItemCount: 1,
      orderPlacedDateText: '2026年9月18日',
      products: [
        { name: '测试商品', quantity: 2, rawStatus: 'PICKED_UP', pickupDateText: '已取货 9月 22' },
      ],
      source: {
        observedAt: new Date(Date.now() - 500).toISOString(),
        status: 200,
        cached: false,
        provider: 'Apple official website',
        host: 'www.apple.com.cn',
        runId: 1,
        sha256: 'a'.repeat(64),
      },
    };
  });
  test('派生计划保留原范围和期限，同步三字段且不修改业务状态及更新时间', async () => {
    const initial = (await client.query('SELECT * FROM orders')).rows[0];
    const derived = await preparePickupStatusPlan(client, plan);
    expect(derived.startedAt).toBe(plan.startedAt);
    const audit = await applyPickupBackfill(client, derived, derived.entries[0], result);
    expect(audit).toMatchObject({ outcome: 'FILLED', date: '2026-09-22', statusSaved: true });
    const row = (await client.query('SELECT *,actual_pickup_date::text AS date FROM orders'))
      .rows[0];
    expect(row.date).toBe('2026-09-22');
    expect(row.official_raw_status).toBe('PICKED_UP');
    expect(row.status).toBe('manual');
    expect(row.updated_at).toEqual(initial.updated_at);
    expect((await applyPickupBackfill(client, derived, derived.entries[0], result)).outcome).toBe(
      'ALREADY_HAS_DATE'
    );
  });
  test('已有日期保留，更新状态不会因原摘要变化破坏幂等', async () => {
    await client.query("UPDATE orders SET actual_pickup_date='2026-09-21'");
    const derived = await preparePickupStatusPlan(client, plan);
    const audit = await applyPickupBackfill(client, derived, derived.entries[0], result);
    expect(audit).toMatchObject({
      outcome: 'ALREADY_HAS_DATE',
      date: '2026-09-21',
      statusSaved: true,
    });
  });
  test('旧证据不会覆盖较新状态', async () => {
    const derived = await preparePickupStatusPlan(client, plan);
    await client.query(
      "UPDATE orders SET official_raw_status='NEWER',official_status_observed_at=now()"
    );
    const audit = await applyPickupBackfill(client, derived, derived.entries[0], result);
    expect(audit.statusSaved).toBe(false);
    expect(
      (await client.query('SELECT official_raw_status FROM orders')).rows[0].official_raw_status
    ).toBe('NEWER');
  });
  test('原行变化阻止派生计划，之后非目标字段变化也阻止写入', async () => {
    const derived = await preparePickupStatusPlan(client, plan);
    await client.query("UPDATE orders SET status='changed'");
    await expect(preparePickupStatusPlan(client, plan)).rejects.toThrow('BACKFILL_ORDER_CHANGED');
    await expect(applyPickupBackfill(client, derived, derived.entries[0], result)).rejects.toThrow(
      'BACKFILL_ORDER_CHANGED'
    );
    expect(
      (await client.query('SELECT actual_pickup_date FROM orders')).rows[0].actual_pickup_date
    ).toBeNull();
  });
  test('部分取货不造日期，但保存官网真实状态', async () => {
    const derived = await preparePickupStatusPlan(client, plan);
    result.products[0].rawStatus = 'READY_FOR_PICKUP';
    const audit = await applyPickupBackfill(client, derived, derived.entries[0], result);
    expect(audit).toMatchObject({
      outcome: 'NOT_ALL_ITEMS_PICKED_UP',
      date: null,
      statusSaved: true,
    });
  });
  test('过期计划拒绝，不通过恢复重新计时', async () => {
    plan.startedAt = new Date(Date.now() - 86401000).toISOString();
    await expect(preparePickupStatusPlan(client, plan)).rejects.toThrow('BACKFILL_SCOPE_INVALID');
    await expect(applyPickupBackfill(client, plan, plan.entries[0], result)).rejects.toThrow(
      'BACKFILL_SCOPE_INVALID'
    );
  });
  test('旧日期专用计划仍兼容，不会擅自写入状态', async () => {
    const audit = await applyPickupBackfill(client, plan, plan.entries[0], result);
    expect(audit.outcome).toBe('FILLED');
    expect(
      (await client.query('SELECT official_raw_status FROM orders')).rows[0].official_raw_status
    ).toBeNull();
  });
  test('新版冻结全部已取货，包含截止日之后与已有日期，排除其他状态', async () => {
    await client.query(
      "UPDATE orders SET email_pickup_date='2026-10-01',actual_pickup_date='2026-09-21'"
    );
    await client.query(`INSERT INTO orders(id,order_number,apple_id,email_order_status,email_pickup_date)
      VALUES(2,'W1234567891','b@example.test','confirmed','2026-09-20')`);
    const frozen = await freezePickupBackfill(client, { allPickedUp: true });
    expect(frozen.entries.map(row => row.id)).toEqual([1]);
    expect(frozen).toMatchObject({ schemaVersion: 2, scope: 'all-picked-up', cutoff: null });
    const derived = await preparePickupStatusPlan(client, frozen);
    result.source.observedAt = new Date().toISOString();
    const audit = await applyPickupBackfill(client, derived, derived.entries[0], result);
    expect(audit).toMatchObject({
      outcome: 'UPDATED',
      previousDate: '2026-09-21',
      date: '2026-09-22',
      dateVerified: true,
    });
    expect((await client.query('SELECT status FROM orders WHERE id=1')).rows[0].status).toBe(
      'manual'
    );
  });
  test('新版遇到较新观测或日期缺失保留已有日期，不假报完成', async () => {
    await client.query("UPDATE orders SET actual_pickup_date='2026-09-21'");
    const frozen = await freezePickupBackfill(client, { allPickedUp: true });
    const derived = await preparePickupStatusPlan(client, frozen);
    result.source.observedAt = frozen.startedAt;
    await client.query("UPDATE orders SET official_status_observed_at=now()+interval '1 second'");
    const audit = await applyPickupBackfill(client, derived, derived.entries[0], result);
    expect(audit).toMatchObject({ date: '2026-09-21', dateVerified: false, statusSaved: false });
    await client.query('UPDATE orders SET official_status_observed_at=NULL');
    result.products[0].pickupDateText = null;
    expect(await applyPickupBackfill(client, derived, derived.entries[0], result)).toMatchObject({
      date: '2026-09-21',
      dateVerified: false,
      statusSaved: true,
    });
  });
  test('范围字段拼错不能升级旧计划，写入前已不再取货则拒绝', async () => {
    await expect(preparePickupStatusPlan(client, { ...plan, scope: 'all' })).rejects.toThrow(
      'BACKFILL_SCOPE_INVALID'
    );
    const frozen = await freezePickupBackfill(client, { allPickedUp: true });
    const derived = await preparePickupStatusPlan(client, frozen);
    result.source.observedAt = new Date().toISOString();
    await client.query("UPDATE orders SET email_order_status='confirmed'");
    await expect(applyPickupBackfill(client, derived, derived.entries[0], result)).rejects.toThrow(
      'BACKFILL_ORDER_CHANGED'
    );
  });
  test('缺失范围严格使用日期或无设备，不限定邮件取货日，也不扩展完整单', async () => {
    await client.query("UPDATE orders SET email_pickup_date='2026-10-01'");
    await client.query(`INSERT INTO orders(id,order_number,apple_id,email_order_status,actual_pickup_date)
      VALUES(2,'W1234567891','b@example.test','picked_up','2026-09-21'),
      (3,'W1234567892','c@example.test','picked_up','2026-09-21'),
      (4,'W1234567893','d@example.test','confirmed',NULL),
      (5,'W1234567894','e@example.test','picked_up',NULL)`);
    await client.query(`INSERT INTO pickup_devices VALUES
      (1,1,'A123456789','unit1'),(2,3,'B123456789','unit2')`);
    const frozen = await freezePickupBackfill(client, { missingFields: true });
    expect(frozen.entries.map(entry => entry.id)).toEqual([1, 2, 5]);
    expect(frozen).toMatchObject({
      schemaVersion: 3,
      scope: 'missing-fields',
      cutoff: null,
      policy: { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 },
    });
    expect(frozen.entries[0]).toMatchObject({
      dateMissing: true,
      serialsMissing: false,
      previousDevices: [{ id: 1 }],
    });
    expect(frozen.entries[0].previousDevices[0]).toHaveProperty('serial_number', 'A123456789');
    expect(frozen.entries[1]).toMatchObject({
      dateMissing: false,
      serialsMissing: true,
      previousDate: '2026-09-21',
      previousDevices: [],
    });
    const derived = await preparePickupStatusPlan(client, frozen);
    result.source.observedAt = new Date().toISOString();
    expect(await applyPickupBackfill(client, derived, derived.entries[0], result)).toMatchObject({
      outcome: 'FILLED',
      dateVerified: true,
      statusSaved: true,
    });
    expect(
      (await client.query('SELECT count(*)::int AS count FROM pickup_devices')).rows[0].count
    ).toBe(2);
  });
  test('缺失范围拒绝混合范围、关闭保护和无缺失基线的计划', async () => {
    await expect(
      freezePickupBackfill(client, { missingFields: true, allPickedUp: true })
    ).rejects.toThrow('BACKFILL_SCOPE_INVALID');
    const frozen = await freezePickupBackfill(client, { missingFields: true });
    await expect(
      preparePickupStatusPlan(client, {
        ...frozen,
        policy: { ...frozen.policy, loginCooldown: false },
      })
    ).rejects.toThrow('BACKFILL_SCOPE_INVALID');
    frozen.entries[0].dateMissing = false;
    frozen.entries[0].serialsMissing = false;
    await expect(preparePickupStatusPlan(client, frozen)).rejects.toThrow('BACKFILL_SCOPE_INVALID');
    result.source.observedAt = new Date().toISOString();
    await expect(applyPickupBackfill(client, frozen, frozen.entries[0], result)).rejects.toThrow(
      'BACKFILL_SCOPE_INVALID'
    );
  });
  test('缺序列号但已有日期的目标，只用较新完整官网日期纠正并保留旧值备份', async () => {
    await client.query("UPDATE orders SET actual_pickup_date='2026-09-21'");
    const frozen = await freezePickupBackfill(client, { missingFields: true });
    const derived = await preparePickupStatusPlan(client, frozen);
    result.source.observedAt = new Date().toISOString();
    const audit = await applyPickupBackfill(client, derived, derived.entries[0], result);
    expect(audit).toMatchObject({
      outcome: 'UPDATED',
      previousDate: '2026-09-21',
      date: '2026-09-22',
      dateVerified: true,
      statusSaved: true,
    });
    expect(frozen.entries[0].previousDate).toBe('2026-09-21');
  });
  test('超过两页时按主键完整冻结且保持同一只读快照和SQL超时', async () => {
    await client.query(`INSERT INTO orders(id,order_number,apple_id,email_order_status,status)
      SELECT i,'W'||lpad(i::text,10,'0'),'test'||i||'@example.test','picked_up','manual'
      FROM generate_series(2,123) i`);
    const calls = [];
    const proxy = {
      query: (sql, values) => {
        calls.push({ sql, values });
        return client.query(sql, values);
      },
    };
    const frozen = await freezePickupBackfill(proxy, { missingFields: true });
    expect(frozen.entries.map(entry => entry.id)).toEqual(
      Array.from({ length: 123 }, (_, i) => i + 1)
    );
    expect(calls[0].sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(calls[1].sql).toBe("SET LOCAL statement_timeout='8s'");
    expect(calls.filter(call => call.sql.startsWith('SELECT')).map(call => call.values)).toEqual([
      [0],
      [50],
      [100],
    ]);
    expect(calls.at(-1).sql).toBe('ROLLBACK');
  });
});
