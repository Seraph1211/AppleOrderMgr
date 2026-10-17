/* eslint-disable camelcase -- 隔离 PostgreSQL 测试契约 */
const suite = process.env.RUN_PROXY_MULTI_CITY_TEST === 'true' ? describe : describe.skip;

suite('代抢多城市真实 PostgreSQL/API 开发回归', () => {
  let models, service, actor, server, origin;
  let sequence = 9800000000;
  const codes = ['R577', 'R639', 'R484', 'R761', 'R793'];
  const source = (city = '广州、深圳全店') =>
    `姓名：合成测试\n身份证后四位：000X\n手机号：13800000001\n邮箱：synthetic-multicity@example.com\n机型：Duo 白色512\n支付方式：微信\n取机城市：${city}\n订单来源：闲鱼`;
  const api = async (path, method = 'GET', body, permission = 'proxy_orders.read') => {
    const response = await fetch(origin + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-permissions': permission },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, json: await response.json() };
  };
  const account = () =>
    models.AppleId.create({
      appleId: `multicity-${++sequence}@example.com`,
      password: 'Synthetic-Multi-City',
      isProxyPool: true,
    });
  const create = async (city = '广州、深圳全店') => {
    const parsed = await api('/parse', 'POST', { text: source(city) });
    expect(parsed.json.data.canSave).toBe(true);
    const saved = await api('/', 'POST', parsed.json.data.draft);
    expect(saved.response.status).toBe(200);
    return models.ProxyOrder.findByPk(saved.json.data.id);
  };

  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_proxy_test_20261017' ||
      process.env.DB_NAME_TEST !== process.env.DB_NAME ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许明确指定隔离多城市测试库，且禁止 DATABASE_URL');
    models = require('../src/models');
    service = require('../src/services/proxyOrderService');
    await models.sequelize.authenticate();
    actor = await models.User.create({
      username: `proxy_multicity_${Date.now()}`,
      password: 'Synthetic-Multi-City-Actor',
      role: 'admin',
      status: 'active',
    });
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = {
        id: actor.id,
        role: 'operator',
        permissions: String(req.headers['x-test-permissions'] || '').split(','),
      };
      next();
    });
    app.use('/api/proxy-orders', require('../src/routes/proxyOrders'));
    app.use(require('../src/middleware/errorHandler'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}/api/proxy-orders`;
  });
  beforeEach(async () => {
    await models.sequelize.query(
      'TRUNCATE proxy_order_links, proxy_events, proxy_assignments, proxy_orders, apple_ids, orders RESTART IDENTITY CASCADE'
    );
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) await models.sequelize.close();
  });

  test('原文解析、保存、列表、详情、原样编辑、复制模板贯通五店', async () => {
    await account();
    const row = await create();
    expect(row.storeCodes).toEqual(codes);
    expect(row.storeCity).toBe('广州、深圳');
    let detail = await api(`/${row.id}`);
    expect(detail.json.data.storeCities).toEqual(['广州', '深圳']);
    const list = await api('/');
    expect(list.json.data.rows[0].storeCities).toEqual(['广州', '深圳']);
    expect(JSON.stringify(list.json)).not.toContain('Synthetic-Multi-City');
    const edited = await api(`/${row.id}`, 'PUT', {
      ...detail.json.data,
      expectedVersion: row.version,
      notes: '合成编辑备注',
    });
    expect(edited.response.status).toBe(200);
    detail = await api(`/${row.id}`);
    expect(detail.json.data.storeCodes).toEqual(codes);
    const copy = await api('/copy', 'POST', { ids: [row.id] });
    expect(copy.response.status).toBe(200);
    expect(copy.response.headers.get('cache-control')).toContain('no-store');
    const template = JSON.stringify(copy.json);
    for (const name of [
      '广州天环广场',
      '广州珠江新城',
      '深圳益田假日广场',
      '深圳万象城',
      '深圳前海壹方城',
    ])
      expect(template).toContain(name);
  });

  test('固定范围旧单编辑及复制不扩张，缺城市旧单推导仍可保存', async () => {
    await account();
    const row = await create();
    await row.update({ storeCodes: ['R577', 'R761'] });
    const edited = await api(`/${row.id}`, 'PUT', {
      expectedVersion: row.version,
      notes: '只改备注',
    });
    expect(edited.response.status).toBe(200);
    expect((await row.reload()).storeCodes).toEqual(['R577', 'R761']);
    const copy = await api('/copy', 'POST', { ids: [row.id] });
    expect(copy.response.status).toBe(200);
    expect(JSON.stringify(copy.json)).toContain('广州天环广场|深圳万象城');
    expect(JSON.stringify(copy.json)).not.toContain('前海');
    await row.update({ storeCity: null });
    expect((await api(`/${row.id}`)).json.data.storeCities).toEqual(['广州', '深圳']);
    const legacyEdit = await api(`/${row.id}`, 'PUT', {
      expectedVersion: row.version,
      notes: '旧单修改',
    });
    expect(legacyEdit.response.status).toBe(200);
    expect((await row.reload()).storeCity).toBe('广州、深圳');
    expect(row.storeCodes).toEqual(['R577', 'R761']);
  });

  test('城市选择可只传新数组修改，全店新建及明确改选展开完整集合', async () => {
    const row = await create('广州');
    const edited = await api(`/${row.id}`, 'PUT', {
      expectedVersion: row.version,
      storeCities: ['广州', '深圳'],
    });
    expect(edited.response.status).toBe(200);
    expect((await row.reload()).storeCodes).toEqual(codes);
    expect(row.storeCity).toBe('广州、深圳');
    const input = require('../src/utils/proxyOrderInput');
    const body = input.parseProxyText(source()).draft;
    body.storeCodes = ['R577', 'R761'];
    body.phone = '13800000002';
    const newOrder = await api('/', 'POST', body);
    expect(newOrder.response.status).toBe(200);
    expect((await models.ProxyOrder.findByPk(newOrder.json.data.id)).storeCodes).toEqual(codes);
  });

  test('原全店范围可原样编辑，同城子集需明确改为指定门店', async () => {
    const row = await create();
    const rejected = await api(`/${row.id}`, 'PUT', {
      expectedVersion: row.version,
      storeCodes: ['R577', 'R761'],
    });
    expect(rejected.response.status).toBe(400);
    expect((await row.reload()).storeCodes).toEqual(codes);
    const selected = await api(`/${row.id}`, 'PUT', {
      expectedVersion: row.version,
      storeMode: 'selected',
      storeCodes: ['R577', 'R761'],
    });
    expect(selected.response.status).toBe(200);
    expect((await row.reload()).storeCodes).toEqual(['R577', 'R761']);
    await row.update({ storeMode: 'city_any' });
    const sameCities = await api(`/${row.id}`, 'PUT', {
      expectedVersion: row.version,
      storeCity: '广州市、深圳市',
      notes: '仅规范城市拼写',
    });
    expect(sameCities.response.status).toBe(200);
    expect((await row.reload()).storeCodes).toEqual(['R577', 'R761']);
  });

  test('两市各店自动匹配，范围外订单保持未关联', async () => {
    await account();
    const row = await create();
    const assignment = await models.ProxyAssignment.findOne({ where: { proxyOrderId: row.id } });
    const officialIds = [];
    for (const pickupStoreCode of [...codes, 'R480']) {
      const order = await models.Order.create({
        orderNumber: `W${++sequence}`,
        appleId: assignment.accountEmail,
        recipientName: row.lastName + row.firstName,
        recipientPhone: row.phone,
        recipientIdLast4: row.idLast4,
        sourceContactEmail: row.email,
        pickupStoreCode,
        products: [{ name: 'iPhone Duo 星光白色 512GB', quantity: 1 }],
        orderDate: new Date(assignment.startedAt.getTime() + 1),
      });
      if (pickupStoreCode !== 'R480') officialIds.push(order.id);
    }
    await service.reconcile();
    const detail = await service.detail(row.id);
    expect(detail.officialOrders.map(order => order.id).sort()).toEqual(officialIds.sort());
    expect((await row.reload()).status).toBe('succeeded');
    await service.reconcile();
    expect(await models.ProxyOrderLink.count({ where: { unlinkedAt: null } })).toBe(5);
  });

  test('未知城市与冲突范围不写库，权限和版本冲突仍生效', async () => {
    const parsed = await api('/parse', 'POST', { text: source('广州、未知全店') });
    expect(parsed.json.data.canSave).toBe(false);
    const invalid = await api('/', 'POST', parsed.json.data.draft);
    expect(invalid.response.status).toBe(400);
    expect(await models.ProxyOrder.count()).toBe(0);
    expect((await api('/parse', 'POST', { text: source() }, '')).response.status).toBe(403);
    const row = await create();
    expect(
      (await api(`/${row.id}`, 'PUT', { expectedVersion: 999, notes: '冲突' })).response.status
    ).toBe(409);
    const conflict = await api(`/${row.id}`, 'PUT', {
      expectedVersion: row.version,
      storeCities: ['广州'],
      storeCity: '深圳',
    });
    expect(conflict.response.status).toBe(400);
    expect((await row.reload()).storeCodes).toEqual(codes);
  });
});
