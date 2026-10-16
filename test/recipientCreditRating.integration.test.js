/* eslint-disable camelcase -- 数据库与 API 字段 */
const { Sequelize, DataTypes } = require('sequelize');
const migration = require('../migrations/20261016000003-add-recipient-credit-rating');

// 只允许显式指定的可销毁隔离容器，禁止指向业务库。
const enabled = process.env.CREDIT_RATING_TEST_DB_HOST === 'recipient-credit-test-postgres';
const suite = enabled ? describe : describe.skip;

suite('取机人信用评级：隔离 PostgreSQL 与 HTTP', () => {
  let sequelize;
  let Recipient;
  let server;
  let baseUrl;
  let qi;
  const oldEnv = { ...process.env };
  const legacyId = 100;

  async function request(path = '', method = 'GET', body, allowed = true) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Test-Access': String(allowed) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      throw new Error(`隔离 HTTP 请求失败：${error.message}`);
    }
  }

  beforeAll(async () => {
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');
    process.env.FIELD_ENCRYPTION_KEY_VERSION = 'v1';
    delete process.env.FIELD_ENCRYPTION_KEYS_JSON;
    delete process.env.FIELD_BLIND_INDEX_KEY;
    sequelize = new Sequelize('recipient_credit_test', 'postgres', 'synthetic-only', {
      host: process.env.CREDIT_RATING_TEST_DB_HOST,
      dialect: 'postgres',
      logging: false,
    });
    qi = sequelize.getQueryInterface();
    Recipient = require('../src/models/Recipient')(sequelize);
    const attributes = {};
    for (const [key, value] of Object.entries(Recipient.rawAttributes)) {
      if (key === 'creditRating') continue;
      const column = { ...value };
      delete column.references;
      attributes[column.field || key] = column;
    }
    await qi.createTable('recipients', attributes);
    await qi.bulkInsert('recipients', [
      {
        id: legacyId,
        last_name: '合成',
        first_name: '旧档案',
        id_card_number: '110101199001010001',
        channel: '原渠道',
        tag: '原TAG',
        notes: '原备注',
        status: '未使用',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    await migration.up(qi, Sequelize);
    jest.doMock('../src/models', () => ({ sequelize, Recipient, Order: {}, AppleId: {} }));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = {
        id: 1,
        role: 'operator',
        orderAccess: { mode: 'all' },
        permissions:
          req.get('X-Test-Access') === 'true'
            ? ['recipients.read', 'recipients.create', 'recipients.edit']
            : [],
      };
      next();
    });
    app.use('/recipients', require('../src/routes/recipients'));
    app.use((error, _req, res, _next) => {
      res.status(error.statusCode || 500).json({ message: error.message });
    });
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/recipients`;
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (sequelize) await sequelize.close();
    for (const key of [
      'FIELD_ENCRYPTION_KEY',
      'FIELD_ENCRYPTION_KEY_VERSION',
      'FIELD_ENCRYPTION_KEYS_JSON',
      'FIELD_BLIND_INDEX_KEY',
    ]) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
  });

  test('应该保留已有档案，列表与详情返回空评级', async () => {
    const detail = await request(`/${legacyId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      credit_rating: null,
      channel: '原渠道',
      tag: '原TAG',
    });
    const list = await request();
    expect(list.body.data.recipients[0].credit_rating).toBeNull();
  });

  test.each(['A', 'B', 'C'])('应该创建并独立回读评级 %s', async creditRating => {
    const result = await request('', 'POST', {
      lastName: '合成',
      firstName: creditRating,
      idCardNumber: `11010119900101000${creditRating.charCodeAt(0) - 63}`,
      creditRating,
    });
    expect(result.status).toBe(201);
    expect(result.body.data.credit_rating).toBe(creditRating);
    expect((await Recipient.findByPk(result.body.data.id)).creditRating).toBe(creditRating);
  });

  test('应该保留省略字段，显式空值清空，新增默认留空', async () => {
    expect((await request(`/${legacyId}`, 'PUT', { creditRating: 'A' })).status).toBe(200);
    await request(`/${legacyId}`, 'PUT', { notes: '更新备注' });
    expect((await Recipient.findByPk(legacyId)).toJSON()).toMatchObject({
      creditRating: 'A',
      channel: '原渠道',
      tag: '原TAG',
      notes: '更新备注',
    });
    for (const value of ['', null]) {
      await request(`/${legacyId}`, 'PUT', { creditRating: 'B' });
      const result = await request(`/${legacyId}`, 'PUT', { creditRating: value });
      expect(result.body.data.credit_rating).toBeNull();
    }
    const created = await request('', 'POST', {
      lastName: '合成',
      firstName: '留空',
      idCardNumber: '110101199001010005',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.credit_rating).toBeNull();
  });

  test('应该拒绝非法输入与无权限编辑，不改变评级及渠道', async () => {
    await request(`/${legacyId}`, 'PUT', { creditRating: 'C' });
    for (const value of ['D', 'a', 1, [], {}]) {
      expect((await request(`/${legacyId}`, 'PUT', { creditRating: value })).status).toBe(400);
    }
    expect((await request(`/${legacyId}`, 'PUT', { creditRating: 'A' }, false)).status).toBe(403);
    expect((await Recipient.findByPk(legacyId)).toJSON()).toMatchObject({
      creditRating: 'C',
      channel: '原渠道',
    });
    await expect(
      Recipient.build({ creditRating: 'D' }).validate({ fields: ['creditRating'] })
    ).rejects.toThrow('信用评级必须是');
    await expect(
      sequelize.query("UPDATE recipients SET credit_rating='D' WHERE id=100")
    ).rejects.toThrow();
  });

  test('应该支持 down/up 并完整保留旧字段', async () => {
    const [before] = await sequelize.query(
      "SELECT to_jsonb(r) - 'credit_rating' AS data FROM recipients r ORDER BY id"
    );
    await migration.down(qi);
    expect(await qi.describeTable('recipients')).not.toHaveProperty('credit_rating');
    await migration.up(qi, DataTypes);
    const [after] = await sequelize.query(
      "SELECT to_jsonb(r) - 'credit_rating' AS data FROM recipients r ORDER BY id"
    );
    expect(after).toEqual(before);
    const [rows] = await sequelize.query('SELECT credit_rating FROM recipients');
    expect(rows.every(row => row.credit_rating === null)).toBe(true);
  });
});
