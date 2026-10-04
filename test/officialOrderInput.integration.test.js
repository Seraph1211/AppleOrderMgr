/* eslint-disable no-magic-numbers -- 独立合成数据库测试。 */
const { Client } = require('pg');
const { encrypt } = require('../src/utils/fieldEncryption');
const { readOfficialOrderInput } = require('../src/services/officialOrderInput');
const enabled = process.env.RUN_OFFICIAL_INPUT_INTEGRATION === 'true';
const database = process.env.DB_NAME;

if (
  enabled &&
  (!/^apple_official_input_test_\d+$/.test(database || '') || process.env.DATABASE_URL)
)
  throw new Error('仅允许独立官网输入测试数据库');

(enabled ? describe : describe.skip)('官网输入真实 PostgreSQL：未关联快照与冲突保护', () => {
  let client;
  beforeAll(async () => {
    client = new Client({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    await client.connect();
    await client.query(`CREATE TABLE IF NOT EXISTS apple_ids (
      id INTEGER PRIMARY KEY, apple_id VARCHAR(255), password TEXT, status VARCHAR(20));
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY,order_number VARCHAR(20),order_url TEXT,apple_id VARCHAR(255),
        apple_password TEXT,apple_id_ref INTEGER,row_marker TEXT);`);
  });
  afterAll(async () => {
    if (client) await client.end();
  });
  beforeEach(async () => {
    await client.query('TRUNCATE orders,apple_ids');
    await client.query('INSERT INTO orders VALUES ($1,$2,$3,$4,$5,NULL,$6)', [
      249,
      'W1234567890',
      'https://www.apple.com.cn/shop/order/list/W1234567890/contact%40example.test',
      'order@example.test',
      encrypt('synthetic-password'),
      'business-fields-must-not-change',
    ]);
  });
  test('无主表但有订单加密快照：真实 SQL 返回有效输入且整行不变', async () => {
    const before = await client.query('SELECT md5(to_jsonb(o)::text) AS hash FROM orders o');
    const value = await readOfficialOrderInput(client, '249');
    expect(value).toMatchObject({
      id: 249,
      password: 'synthetic-password',
      credentialSource: 'orderSnapshot',
    });
    expect(
      (await client.query('SELECT md5(to_jsonb(o)::text) AS hash FROM orders o')).rows
    ).toEqual(before.rows);
    expect((await client.query('SELECT count(*)::int AS count FROM apple_ids')).rows[0].count).toBe(
      0
    );
  });
  test('唯一匹配账号沿用主表并检查快照一致', async () => {
    await client.query('INSERT INTO apple_ids VALUES (10,$1,$2,$3)', [
      ' ORDER@EXAMPLE.TEST ',
      encrypt('synthetic-password'),
      '使用中',
    ]);
    await client.query('UPDATE orders SET apple_id_ref=10');
    await expect(readOfficialOrderInput(client, '249')).resolves.toMatchObject({
      credentialSource: 'accountRegistry',
      snapshotPasswordMatches: true,
    });
  });
  test('引用别的账号时拒绝，不通过快照绕开关联冲突', async () => {
    await client.query('INSERT INTO apple_ids VALUES (10,$1,$2,$3)', [
      'another@example.test',
      encrypt('synthetic-password'),
      '使用中',
    ]);
    await client.query('UPDATE orders SET apple_id_ref=10');
    await expect(readOfficialOrderInput(client, '249')).rejects.toThrow(
      'ACCOUNT_REFERENCE_CONFLICT'
    );
  });
  test('大小写重复候选、异常账号和密码更新均明确拒绝', async () => {
    await client.query('INSERT INTO apple_ids VALUES (10,$1,$2,$3)', [
      'order@example.test',
      encrypt('synthetic-password'),
      '异常',
    ]);
    await expect(readOfficialOrderInput(client, '249')).rejects.toThrow('ACCOUNT_MARKED_INVALID');
    await client.query('UPDATE apple_ids SET status=$1,password=$2', [
      '使用中',
      encrypt('new-password'),
    ]);
    await expect(readOfficialOrderInput(client, '249')).rejects.toThrow(
      'CREDENTIAL_SNAPSHOT_MISMATCH'
    );
    await client.query('INSERT INTO apple_ids VALUES (11,$1,$2,$3)', [
      'ORDER@example.test',
      encrypt('synthetic-password'),
      '使用中',
    ]);
    await expect(readOfficialOrderInput(client, '249')).rejects.toThrow('ORDER_ACCOUNT_AMBIGUOUS');
  });
  test('缺失订单和缺失密码只报对应错误，事务结束后连接仍可用', async () => {
    await expect(readOfficialOrderInput(client, '999')).rejects.toThrow('ORDER_NOT_FOUND');
    await client.query('UPDATE orders SET apple_password=NULL');
    await expect(readOfficialOrderInput(client, '249')).rejects.toThrow(
      'ORDER_CREDENTIALS_MISSING'
    );
    expect((await client.query('SELECT count(*)::int AS count FROM orders')).rows[0].count).toBe(1);
  });
});
