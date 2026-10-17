/* eslint-disable camelcase -- 隔离 PostgreSQL 字段契约 */
const suite = process.env.RUN_PROXY_MULTI_CITY_ACCEPTANCE === 'true' ? describe : describe.skip;
const expectedCodes = ['R484', 'R577', 'R639', 'R761', 'R793'];
const sorted = values => [...values].sort();

suite('PRX-02-MULTI-CITY 独立 PostgreSQL/HTTP 验收', () => {
  let models, service, input, actor, server, origin;
  let sequence = 9800000000;
  const payload = (extra = {}) => ({
    lastName: '合成',
    firstName: '测试',
    phone: '13800000001',
    email: 'synthetic-multicity@example.com',
    idLast4: '000X',
    productModel: 'iPhone Duo',
    color: '星光白色',
    storage: '512GB',
    productCandidates: [{ productModel: 'iPhone Duo', color: '星光白色', storage: '512GB' }],
    quantity: 1,
    storeMode: 'city_any',
    storeCities: ['广州', '深圳'],
    storeCity: '广州、深圳',
    storeCodes: expectedCodes,
    billing: input.generateProxyAddress('R577'),
    paymentMethod: '微信',
    orderSource: '闲鱼',
    rawText: '独立合成多城市原文',
    notes: '独立合成备注',
    ...extra,
  });
  const api = async (path, method = 'GET', body, permissions = 'proxy_orders.read') => {
    try {
      const response = await fetch(origin + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-test-permissions': permissions },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, json: await response.json() };
    } catch (error) {
      throw new Error(`合成 HTTP 失败: ${error.message}`);
    }
  };
  const create = async (extra = {}) => {
    try {
      const result = await api('', 'POST', payload(extra));
      expect(result.response.status).toBe(200);
      return result.json.data.id;
    } catch (error) {
      throw new Error(`独立合成验收步骤失败: ${error.message}`, { cause: error });
    }
  };
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_proxy_test_20261017' ||
      process.env.DB_NAME_TEST !== process.env.DB_NAME ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许独立20261017合成库且DB_NAME_TEST相同，禁止DATABASE_URL');
    models = require('../src/models');
    service = require('../src/services/proxyOrderService');
    input = require('../src/utils/proxyOrderInput');
    await models.sequelize.authenticate();
    actor = await models.User.create({
      username: `proxy_multicity_${Date.now()}`,
      password: 'Synthetic-Multicity-Actor',
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

  test('AC-07 HTTP新建、列表、详情和编辑完整保存五店及城市', async () => {
    const id = await create();
    const stored = await models.ProxyOrder.findByPk(id);
    expect(sorted(stored.storeCodes)).toEqual(expectedCodes);
    expect(stored.storeCity).toBe('广州、深圳');
    const first = await api(`/${id}`);
    expect(first.json.data.storeCities).toEqual(['广州', '深圳']);
    expect(sorted(first.json.data.storeCodes)).toEqual(expectedCodes);
    expect((await api('')).json.data.rows[0].storeCities).toEqual(['广州', '深圳']);
    const edited = await api(`/${id}`, 'PUT', {
      ...first.json.data,
      notes: '修改备注不丢多城市',
      expectedVersion: first.json.data.version,
    });
    expect(edited.response.status).toBe(200);
    const after = (await api(`/${id}`)).json.data;
    expect(after.notes).toBe('修改备注不丢多城市');
    expect(after.storeCities).toEqual(['广州', '深圳']);
    expect(sorted(after.storeCodes)).toEqual(expectedCodes);
    expect(first.response.headers.get('cache-control')).toContain('no-store');
  });

  test('AC-08 历史city_any固化子集读取、编辑与模板不重新扩张', async () => {
    const id = await create();
    await models.ProxyOrder.update({ storeCodes: ['R577', 'R484'] }, { where: { id } });
    const first = (await api(`/${id}`)).json.data;
    expect(sorted(first.storeCodes)).toEqual(['R484', 'R577']);
    expect((await api('')).json.data.rows[0].storeCodes).toEqual(first.storeCodes);
    const edited = await api(`/${id}`, 'PUT', {
      ...first,
      notes: '固化集合不得按城市扩张',
      expectedVersion: first.version,
    });
    expect(edited.response.status).toBe(200);
    const after = (await api(`/${id}`)).json.data;
    expect(sorted(after.storeCodes)).toEqual(['R484', 'R577']);
    const template = input.buildProxyTemplate(after, {
      appleId: 'synthetic-pool@example.com',
      password: 'Synthetic-Only',
    });
    expect(sorted(template.split(',')[2].split('|'))).toEqual(['广州天环广场', '深圳益田假日广场']);
  });

  test('AC-08 明确改城市全店重建集合、跨城市指定子集精确持久化', async () => {
    const id = await create();
    let first = (await api(`/${id}`)).json.data;
    expect(
      (
        await api(`/${id}`, 'PUT', {
          ...first,
          storeCity: '深圳',
          storeCities: ['深圳'],
          storeCodes: [],
          billing: input.generateProxyAddress('R484'),
          expectedVersion: first.version,
        })
      ).response.status
    ).toBe(200);
    first = (await api(`/${id}`)).json.data;
    expect(sorted(first.storeCodes)).toEqual(['R484', 'R761', 'R793']);
    expect(
      (
        await api(`/${id}`, 'PUT', {
          ...first,
          storeMode: 'selected',
          storeCities: ['广州', '深圳'],
          storeCity: '广州、深圳',
          storeCodes: ['R577', 'R484'],
          billing: input.generateProxyAddress('R577'),
          expectedVersion: first.version,
        })
      ).response.status
    ).toBe(200);
    expect(sorted((await api(`/${id}`)).json.data.storeCodes)).toEqual(['R484', 'R577']);
  });

  test('AC-09 旧单城市DTO无storeCities可编辑、复制且保留单店范围', async () => {
    const old = payload({ storeCity: '广州', storeMode: 'selected', storeCodes: ['R577'] });
    old.storeCities = undefined;
    const id = await create(old);
    const first = (await api(`/${id}`)).json.data;
    expect(first.storeCities).toEqual(['广州']);
    delete first.storeCities;
    expect(
      (
        await api(`/${id}`, 'PUT', {
          ...first,
          notes: '旧客户端编辑',
          expectedVersion: first.version,
        })
      ).response.status
    ).toBe(200);
    expect((await models.ProxyOrder.findByPk(id)).storeCodes).toEqual(['R577']);
  });

  test('AC-10 非法范围、范围外账单参考、无权限和旧版本均不写入', async () => {
    for (const extra of [
      { storeMode: 'selected', storeCodes: [] },
      { storeMode: 'selected', storeCodes: ['R000'] },
      { storeCities: ['广州', '未知城'] },
      { storeCities: [] },
      { billing: input.generateProxyAddress('R480') },
    ])
      expect((await api('', 'POST', payload(extra))).response.status).toBe(400);
    expect(await models.ProxyOrder.count()).toBe(0);
    expect((await api('', 'POST', payload(), '')).response.status).toBe(403);
    expect(await models.ProxyOrder.count()).toBe(0);
    const id = await create();
    expect((await api(`/${id}`, 'PUT', payload({ expectedVersion: 999 }))).response.status).toBe(
      409
    );
    expect((await models.ProxyOrder.findByPk(id)).version).toBe(1);
  });

  test('AC-11 每一门店真实reconcile自动关联成功、范围外不关联、复制五店', async () => {
    await models.AppleId.create({
      appleId: 'synthetic-pool@example.com',
      password: 'Synthetic-Only',
      isProxyPool: true,
    });
    const id = await create();
    const row = await models.ProxyOrder.findByPk(id);
    const assignment = await models.ProxyAssignment.findOne({ where: { proxyOrderId: id } });
    const copied = await api('/copy', 'POST', { ids: [id] });
    expect(copied.response.status).toBe(200);
    expect(copied.json.data.text.split(',')[2].split('|')).toHaveLength(5);
    for (const pickupStoreCode of [...expectedCodes, 'R480']) {
      await models.Order.create({
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
    }
    await service.reconcile();
    const after = await service.detail(id);
    expect(after.status).toBe('succeeded');
    expect(sorted(after.officialOrders.map(order => order.pickupStoreCode))).toEqual(expectedCodes);
    expect(await models.ProxyOrderLink.count({ where: { proxyOrderId: id } })).toBe(5);
  });
});
