/* eslint-disable camelcase -- 隔离 PostgreSQL 契约 */
const suite = process.env.RUN_PROXY_V2_FEEDBACK_ACCEPTANCE === 'true' ? describe : describe.skip;

suite('代抢上线反馈独立真实 HTTP/PostgreSQL 验收', () => {
  let models, actor, server, origin;
  let sequence = 9900000000;
  const payload = (extra = {}) => ({
    lastName: '张',
    firstName: '三',
    phone: '13800000001',
    email: 'customer1@example.com',
    idLast4: '0123',
    productModel: 'iPhone Duo',
    color: '星光白色',
    storage: '256GB',
    productCandidates: [{ productModel: 'iPhone Duo', color: '星光白色', storage: '256GB' }],
    quantity: 1,
    storeMode: 'selected',
    storeCity: '重庆',
    storeCodes: ['R480', 'R573'],
    billing: {
      province: '重庆',
      city: '重庆',
      district: '渝中区',
      streetAddress: '合成路1号',
      referenceStoreCode: 'R480',
    },
    paymentMethod: '微信',
    orderSource: '闲鱼',
    rawText: '独立合成原文',
    notes: '只能10.24～10.25取货',
    ...extra,
  });
  const account = () =>
    models.AppleId.create({
      appleId: `acceptance-${++sequence}@example.com`,
      password: 'Synthetic-V2-Pass',
      isProxyPool: true,
    });
  const api = async (path, method = 'GET', body, permission = 'proxy_orders.read') => {
    const response = await fetch(origin + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-permissions': permission },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, json: await response.json() };
  };
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_proxy_feedback_acceptance_20261016' ||
      process.env.DB_NAME_TEST !== process.env.DB_NAME ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许显式独立代抢二期测试库且 DB_NAME_TEST 相同，禁止 DATABASE_URL');
    models = require('../src/models');
    await models.sequelize.authenticate();
    actor = await models.User.create({
      username: `proxy_v2_acceptance_${Date.now()}`,
      password: 'Synthetic-V2-Actor',
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

  const createHttp = async extra => {
    const result = await api('', 'POST', payload(extra));
    expect(result.response.status).toBe(200);
    return result.json.data;
  };
  const assignedIds = async orderId =>
    (await models.ProxyAssignment.findAll({ where: { proxyOrderId: orderId, endedAt: null } })).map(
      row => row.appleIdRef
    );

  test('真实HTTP空池仍登记，自动分配不足返回可见业务错误，复制未分配拒绝', async () => {
    const row = await createHttp();
    expect(row.assigned).toBe(0);
    expect(row.assignmentStatus).toBe('awaiting_account');
    expect(row.assignmentMessage).toMatch(/暂无|待分配/);
    const result = await api(`/${row.id}/accounts`, 'POST', {
      expectedVersion: row.version,
      count: 1,
    });
    expect(result.response.status).toBe(409);
    expect(result.json.error.message).toMatch(/不足|账号/);
    expect(await assignedIds(row.id)).toHaveLength(0);
    expect((await api('/copy', 'POST', { ids: [row.id] })).response.status).toBe(409);
  });

  test.each([1, '1', 2, '2'])('真实HTTP自动追加count=%p，类型及分配数量准确', async count => {
    const row = await createHttp();
    await account();
    await account();
    const result = await api(`/${row.id}/accounts`, 'POST', {
      expectedVersion: row.version,
      count,
    });
    expect(result.response.status).toBe(200);
    expect(typeof result.json.data.assigned).toBe('number');
    expect(result.json.data.assigned).toBe(Number(count));
    expect(await assignedIds(row.id)).toHaveLength(Number(count));
    const list = await api('/accounts');
    expect(typeof list.json.data.availableCount).toBe('number');
    expect(list.json.data.availableCount).toBe(2 - Number(count));
  });

  test('真实HTTP手选使用中账号可复制，无需reset且未被选账号保持', async () => {
    const row = await createHttp();
    const used = await account();
    await used.update({ status: '使用中', notes: '历史使用中待工作人员核实' });
    const usedBefore = used.toJSON();
    const available = await account();
    const result = await api(`/${row.id}/accounts`, 'POST', {
      expectedVersion: row.version,
      accountIds: [String(used.id)],
    });
    expect(result.response.status).toBe(200);
    expect(await assignedIds(row.id)).toEqual([used.id]);
    expect((await used.reload()).status).toBe(usedBefore.status);
    expect(used.notes).toBe(usedBefore.notes);
    const copied = await api('/copy', 'POST', { ids: [row.id] });
    expect(copied.response.status).toBe(200);
    expect(copied.json.data.count).toBe(1);
    expect(copied.json.data.text.split(',')[0]).toBe(used.appleId);
    expect(copied.response.headers.get('cache-control')).toContain('no-store');
    const other = await createHttp({ confirmedDuplicate: true });
    expect(other.assigned).toBe(1);
    expect(await assignedIds(other.id)).toEqual([available.id]);
    expect(await models.ProxyEvent.count({ where: { action: 'pool_status' } })).toBe(0);
    expect((await used.reload()).status).toBe('使用中');
  });

  test.each([0, -1, 1.5, 'no', '', true, {}, [], 21])(
    '非法count=%p应拒绝且不产生占用',
    async count => {
      const row = await createHttp();
      await account();
      const result = await api(`/${row.id}/accounts`, 'POST', {
        expectedVersion: row.version,
        count,
      });
      expect(result.response.status).toBe(400);
      expect(await assignedIds(row.id)).toHaveLength(0);
    }
  );

  test('未使用/使用中足池登记均可占用，两个委托并发不会双占', async () => {
    const used = await account();
    await used.update({ status: '使用中' });
    const available = await account();
    const [x, y] = await Promise.all([
      createHttp({ phone: '13800000003' }),
      createHttp({ phone: '13800000004' }),
    ]);
    expect(x.assigned + y.assigned).toBe(2);
    expect(
      await models.ProxyAssignment.count({ where: { appleIdRef: available.id, endedAt: null } })
    ).toBe(1);
    expect((await used.reload()).status).toBe('使用中');
    expect(
      await models.ProxyAssignment.count({ where: { appleIdRef: used.id, endedAt: null } })
    ).toBe(1);
  });

  test.each(['已下架', '异常', '普通池', '已占用'])(
    '自动/手选均排除%s，错误不修改其他记录',
    async kind => {
      const row = await createHttp();
      const candidate = await account();
      if (kind === '普通池') await candidate.update({ isProxyPool: false });
      else if (kind === '已占用') await createHttp({ phone: '13800000005' });
      else await candidate.update({ status: kind });
      const before = (await candidate.reload()).toJSON();
      const result = await api(`/${row.id}/accounts`, 'POST', {
        expectedVersion: row.version,
        accountIds: [candidate.id],
      });
      expect(result.response.status).toBe(409);
      expect(await assignedIds(row.id)).toEqual([]);
      expect((await candidate.reload()).toJSON()).toEqual(before);
      const automatic = await api(`/${row.id}/accounts`, 'POST', {
        expectedVersion: row.version,
        count: 1,
      });
      expect(automatic.response.status).toBe(409);
      expect((await api('/accounts?availableOnly=true')).json.data.rows).toHaveLength(0);
    }
  );

  test('availableOnly真实SQL分页排除前100不可用记录并返回后方使用中账号', async () => {
    await models.AppleId.bulkCreate(
      Array.from({ length: 101 }, (_, index) => ({
        appleId: `excluded-${index}@example.com`,
        password: 'Synthetic-Excluded',
        status: '已下架',
        isProxyPool: true,
      }))
    );
    const candidate = await account();
    await candidate.update({ status: '使用中' });
    const result = await api('/accounts?availableOnly=true&limit=1&page=1');
    expect(result.response.status).toBe(200);
    expect(result.json.data.rows.map(row => row.id)).toEqual([candidate.id]);
    expect(result.json.data.availableCount).toBe(1);
    expect((await api('/accounts?availableOnly=true&scope=candidates')).response.status).toBe(400);
  });
});
