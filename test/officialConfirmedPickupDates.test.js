/* eslint-disable no-magic-numbers -- 用户确认的固定案例和隔离数据库测试。 */
const { Client } = require('pg');
const {
  applyConfirmedPickupDates,
} = require('../scripts/officialPickupBackfill/applyConfirmedPickupDates');
const cases = [
  [1093, 'W1553961157', '2026-09-27', 1417, '2026年9月28日'],
  [1094, 'W1458808592', '2026-09-27', 1419, '2026年9月28日'],
  [1099, 'W1439008871', '2026-09-28', 1421, '2026年9月29日'],
  [1183, 'W1493825639', '2026-09-29', 1476, '2026年9月30日'],
];
function makePayload() {
  return {
    version: 1,
    authorization: '这4单按照原样保存即可',
    planSha256: 'a'.repeat(64),
    entries: cases.map(([orderId, orderNumber, proposedDate, runId, placed]) => ({
      orderId,
      orderNumber,
      proposedDate,
      runId,
      priorHttpAfterHash: 'b'.repeat(32),
      sourceResult: {
        orderNumber,
        identityMatched: true,
        sourceModel: 'orderDetail',
        orderPlacedDateText: placed,
        completeItemCount: 2,
        source: { runId, sha256: 'c'.repeat(64) },
        products: [1, 2].map(() => ({
          quantity: 1,
          rawStatus: 'PICKED_UP',
          pickupDateText: `已取货 9月 ${Number(proposedDate.slice(-2))}`,
        })),
      },
    })),
  };
}
describe('固定确认日期边界', () => {
  test.each([
    'authorization',
    'id',
    'date',
    'status',
    'source',
    'quantity',
    'run',
    'missing',
    'duplicate',
  ])('拒绝错误的%s且不访问数据库', async field => {
    const payload = makePayload();
    const entry = payload.entries[0];
    if (field === 'authorization') payload.authorization = '';
    if (field === 'id') entry.orderId = 1;
    if (field === 'date') entry.proposedDate = '2026-09-28';
    if (field === 'status') entry.sourceResult.products[0].rawStatus = 'RETURN_STARTED';
    if (field === 'source') entry.sourceResult.products[0].pickupDateText = '已取货9月28';
    if (field === 'quantity') entry.sourceResult.products[0].quantity = 2;
    if (field === 'run') entry.runId = 100;
    if (field === 'missing') payload.entries.pop();
    if (field === 'duplicate') payload.entries[1] = entry;
    const client = { query: jest.fn() };
    await expect(
      applyConfirmedPickupDates(client, payload, { mode: 'dry-run' })
    ).rejects.toMatchObject({ code: 'CONFIRMED_DATE_PAYLOAD_INVALID', rollbackConfirmed: true });
    expect(client.query).not.toHaveBeenCalled();
  });
});
const integration =
  process.env.PICKUP_TEST_DB_HOST === 'official-order-rebuild-postgres' ? describe : describe.skip;
integration('真实隔离PG四单原子补录', () => {
  let client;
  let payload;
  beforeEach(async () => {
    client = new Client({
      host: process.env.PICKUP_TEST_DB_HOST,
      user: 'postgres',
      password: 'test-only',
      database: 'postgres',
    });
    await client.connect();
    await client.query(`CREATE TEMP TABLE orders(id int PRIMARY KEY,order_number text,email_order_status text,
      official_raw_status text,actual_pickup_date date,amount numeric(12,2),notes text);
      CREATE TEMP TABLE pickup_devices(id int,order_id int)`);
    payload = makePayload();
    for (const e of payload.entries) {
      await client.query(
        "INSERT INTO orders VALUES($1,$2,'picked_up','PICKED_UP',null,123.00,'keep')",
        [e.orderId, e.orderNumber]
      );
    }
    const { rows } = await client.query('SELECT id,md5(to_jsonb(o)::text) AS hash FROM orders o');
    payload.entries.forEach(e => {
      e.priorHttpAfterHash = rows.find(r => r.id === e.orderId).hash;
    });
  });
  afterEach(async () => {
    await client.end();
  });
  test('预览零写，四单仅填日期，禁止重放', async () => {
    const preview = await applyConfirmedPickupDates(client, payload, { mode: 'dry-run' });
    expect(preview.businessWrites).toBe(0);
    const result = await applyConfirmedPickupDates(client, payload, { mode: 'apply', preview });
    expect(result.businessWrites).toBe(4);
    result.rows.forEach((r, i) =>
      expect(r.afterSnapshot).toEqual({ ...r.beforeSnapshot, ['actual_pickup_date']: cases[i][2] })
    );
    await expect(
      applyConfirmedPickupDates(client, payload, { mode: 'apply', preview })
    ).rejects.toMatchObject({ rollbackConfirmed: true });
  });
  test('任一订单变化则四单均不写', async () => {
    const preview = await applyConfirmedPickupDates(client, payload, { mode: 'dry-run' });
    await client.query("UPDATE orders SET notes='changed' WHERE id=1183");
    await expect(
      applyConfirmedPickupDates(client, payload, { mode: 'apply', preview })
    ).rejects.toMatchObject({ rollbackConfirmed: true });
    expect(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM orders WHERE actual_pickup_date IS NOT NULL'
        )
      ).rows[0].n
    ).toBe(0);
  });
  test('最后一单违反约束时前三单也回滚', async () => {
    const preview = await applyConfirmedPickupDates(client, payload, { mode: 'dry-run' });
    await client.query('ALTER TABLE orders ADD CHECK (id<>1183 OR actual_pickup_date IS NULL)');
    await expect(
      applyConfirmedPickupDates(client, payload, { mode: 'apply', preview })
    ).rejects.toMatchObject({ rollbackConfirmed: true });
    expect(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM orders WHERE actual_pickup_date IS NOT NULL'
        )
      ).rows[0].n
    ).toBe(0);
  });
  test('提交响应丢失不得声称回滚或再次提交', async () => {
    const preview = await applyConfirmedPickupDates(client, payload, { mode: 'dry-run' });
    const query = client.query.bind(client);
    const mockClient = {
      query: async (...args) => {
        const value = await query(...args);
        if (args[0] === 'COMMIT') throw Error('lost');
        return value;
      },
    };
    await expect(
      applyConfirmedPickupDates(mockClient, payload, { mode: 'apply', preview })
    ).rejects.toMatchObject({ rollbackConfirmed: false });
    expect(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM orders WHERE actual_pickup_date IS NOT NULL'
        )
      ).rows[0].n
    ).toBe(4);
  });
});
