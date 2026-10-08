/* eslint-disable no-magic-numbers -- 固定历史案例及隔离数据库边界测试。 */
const { Client } = require('pg');
const { applyHistoricalDate } = require('../scripts/officialPickupBackfill/applyHistoricalDate');

function payload() {
  return {
    version: 1,
    kind: 'VERIFIED_LEGACY_PICKUP_DATE',
    orderId: 605,
    sourceRunId: 47,
    sourceBodySha256: '67ac30a975598bd02dfe0ddf0932f8bdaa68ceb082f60fa72a6d2ecc821ea6b0',
    sourceObservedAt: '2026-10-03T17:06:42.294Z',
    planSha256: 'a'.repeat(64),
    proofSha256: 'b'.repeat(64),
    priorHttpAfterHash: 'c'.repeat(32),
    orderNumber: 'W1234567890',
    proposedDate: '2026-09-23',
    sourceResult: {
      orderNumber: 'W1234567890',
      identityMatched: true,
      sourceModel: 'orderDetail',
      completeItemCount: 2,
      orderPlacedDateText: '2026年9月20日',
      products: [1, 2].map(() => ({
        quantity: 1,
        rawStatus: 'PICKED_UP',
        pickupDateText: '已取货 9月23日',
      })),
    },
  };
}

describe('历史日期输入边界', () => {
  test.each([
    ['orderId', 606],
    ['sourceRunId', 48],
    ['sourceBodySha256', 'd'.repeat(64)],
    ['sourceObservedAt', '2026-10-08T00:00:00.000Z'],
    ['kind', 'HTTP_SAMPLE'],
    ['proposedDate', '2026-09-24'],
    ['planSha256', 'wrong'],
    ['proofSha256', 'wrong'],
    ['priorHttpAfterHash', 'wrong'],
    ['orderNumber', 'W0987654321'],
  ])('%s不匹配时不访问数据库', async (key, value) => {
    const input = payload();
    input[key] = value;
    const client = { query: jest.fn() };
    await expect(applyHistoricalDate(client, input, { mode: 'dry-run' })).rejects.toMatchObject({
      code: 'HISTORICAL_DATE_PAYLOAD_INVALID',
      rollbackConfirmed: true,
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  test.each(['RETURN_STARTED', 'READY_FOR_PICKUP'])('拒绝%s推导日期', async status => {
    const input = payload();
    input.sourceResult.products[0].rawStatus = status;
    await expect(applyHistoricalDate({}, input, { mode: 'dry-run' })).rejects.toMatchObject({
      code: 'HISTORICAL_DATE_PAYLOAD_INVALID',
    });
  });

  test('禁止无预览直接提交', async () => {
    await expect(applyHistoricalDate({}, payload(), { mode: 'apply' })).rejects.toMatchObject({
      code: 'HISTORICAL_DATE_PREVIEW_INVALID',
    });
  });
});

const integration =
  process.env.PICKUP_TEST_DB_HOST === 'official-order-rebuild-postgres' ? describe : describe.skip;

integration('真实隔离PostgreSQL：历史日期只填空', () => {
  let client;
  let input;
  let preview;

  beforeEach(async () => {
    client = new Client({
      host: process.env.PICKUP_TEST_DB_HOST,
      user: 'postgres',
      password: 'test-only',
      database: 'postgres',
    });
    await client.connect();
    await client.query("SET TIME ZONE 'Asia/Shanghai'");
    await client.query(`CREATE TEMP TABLE orders (
      id int PRIMARY KEY, order_number text, email_order_status text, actual_pickup_date date,
      official_raw_status text, official_status_observed_at timestamptz, updated_at timestamptz,
      manual_note text);
      CREATE TEMP TABLE pickup_devices (id uuid PRIMARY KEY,order_id int,serial_number text);
      INSERT INTO orders VALUES(605,'W1234567890','picked_up',NULL,'RETURN_STARTED',
      '2026-10-08T01:00:00Z','2026-09-25T01:00:00Z','preserve');
      INSERT INTO pickup_devices VALUES('10000000-0000-0000-0000-000000000001',605,'TEST_SERIAL');`);
    input = payload();
    const result = await client.query('SELECT md5(to_jsonb(o)::text) AS hash FROM orders o');
    input.priorHttpAfterHash = result.rows[0].hash;
    preview = await applyHistoricalDate(client, input, { mode: 'dry-run' });
  });

  afterEach(async () => {
    if (client) await client.end();
  });

  test('只填日期，完整行其他字段与设备不变，重复调用拒绝', async () => {
    expect(preview.businessWrites).toBe(0);
    const result = await applyHistoricalDate(client, input, { mode: 'apply', preview });
    expect(result.dateFilled).toBe(true);
    expect(result.businessWrites).toBe(1);
    expect(result.afterSnapshot).toEqual({
      ...result.beforeSnapshot,
      ['actual_pickup_date']: '2026-09-23',
    });
    expect(result.afterSnapshot.official_raw_status).toBe('RETURN_STARTED');
    expect(result.devices).toEqual(preview.devices);
    await expect(
      applyHistoricalDate(client, input, { mode: 'apply', preview })
    ).rejects.toMatchObject({
      code: 'HISTORICAL_DATE_ORDER_CHANGED',
      rollbackConfirmed: true,
    });
  });

  test('已有日期保持，不用历史日期覆盖', async () => {
    await client.query("UPDATE orders SET actual_pickup_date='2026-09-24'");
    await expect(
      applyHistoricalDate(client, input, { mode: 'apply', preview })
    ).rejects.toMatchObject({
      code: 'HISTORICAL_DATE_ORDER_CHANGED',
    });
    const row = await client.query('SELECT actual_pickup_date::text AS date FROM orders');
    expect(row.rows[0].date).toBe('2026-09-24');
  });

  test('预览后订单手工字段变化拒绝提交', async () => {
    await client.query("UPDATE orders SET manual_note='changed'");
    await expect(
      applyHistoricalDate(client, input, { mode: 'apply', preview })
    ).rejects.toMatchObject({
      code: 'HISTORICAL_DATE_ORDER_CHANGED',
    });
  });

  test('预览后设备变化拒绝提交', async () => {
    await client.query("UPDATE pickup_devices SET serial_number='CHANGED'");
    await expect(
      applyHistoricalDate(client, input, { mode: 'apply', preview })
    ).rejects.toMatchObject({
      code: 'HISTORICAL_DATE_PREVIEW_CHANGED',
    });
  });

  test('触发器更改其他订单字段时回滚整个写入', async () => {
    await client.query(`CREATE FUNCTION pg_temp.mutate_note() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.manual_note='unexpected'; RETURN NEW; END $$;
      CREATE TRIGGER mutate_note BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION pg_temp.mutate_note()`);
    await expect(
      applyHistoricalDate(client, input, { mode: 'apply', preview })
    ).rejects.toMatchObject({
      code: 'HISTORICAL_DATE_AFTER_CHANGED',
      rollbackConfirmed: true,
    });
    const row = await client.query('SELECT actual_pickup_date,manual_note FROM orders');
    expect(row.rows[0]).toEqual({ ['actual_pickup_date']: null, ['manual_note']: 'preserve' });
  });

  test('COMMIT已执行但响应丢失，不宣称回滚且禁止自动重试', async () => {
    const bridge = {
      query: async (...args) => {
        const value = await client.query(...args);
        if (args[0] === 'COMMIT') throw new Error('synthetic transport loss');
        return value;
      },
    };
    await expect(
      applyHistoricalDate(bridge, input, { mode: 'apply', preview })
    ).rejects.toMatchObject({
      rollbackConfirmed: false,
    });
    const row = await client.query('SELECT actual_pickup_date::text AS date FROM orders');
    expect(row.rows[0].date).toBe('2026-09-23');
  });
});
