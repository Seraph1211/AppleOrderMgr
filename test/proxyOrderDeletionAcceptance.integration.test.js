/* eslint-disable camelcase -- 隔离 PostgreSQL 契约 */
const suite = process.env.RUN_PROXY_DELETE_ACCEPTANCE === 'true' ? describe : describe.skip;

suite('代抢软删除独立真实认证/HTTP/PostgreSQL 验收', () => {
  let models, actor, other, server, origin, token, otherToken;
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
  const api = async (path, method = 'GET', body, authentication) => {
    const selectedToken = authentication === undefined ? token : authentication;
    const response = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(selectedToken ? { Authorization: `Bearer ${selectedToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, json: await response.json() };
  };
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_proxy_delete_acceptance_20261016' ||
      process.env.DB_NAME_TEST !== process.env.DB_NAME ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许显式独立代抢二期测试库且 DB_NAME_TEST 相同，禁止 DATABASE_URL');
    models = require('../src/models');
    await models.sequelize.authenticate();
    const { randomUUID } = require('node:crypto');
    const createActor = async (suffix, permitted) => {
      const sessionId = randomUUID();
      const user = await models.User.create({
        username: `proxy_delete_${suffix}_${Date.now()}`,
        password: 'Synthetic-Delete-Actor',
        role: 'operator',
        status: 'active',
        activeSessions: [
          {
            id: sessionId,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        ],
      });
      if (permitted)
        await models.UserPermission.create({
          userId: user.id,
          permissionCode: 'proxy_orders.read',
        });
      return {
        user,
        token: require('../src/utils/jwtUtils').generateToken({
          userId: user.id,
          username: user.username,
          role: user.role,
          sessionId,
        }),
      };
    };
    const permitted = await createActor('read', true),
      unpermitted = await createActor('none', false);
    actor = permitted.user;
    token = permitted.token;
    other = unpermitted.user;
    otherToken = unpermitted.token;
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/proxy-orders', require('../src/middleware/authMiddleware').authenticate);
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
  const rowModel = id => models.ProxyOrder.unscoped().findByPk(id);
  const deleteHttp = (row, extra = {}) =>
    api(`/${row.id}/delete`, 'POST', { expectedVersion: row.version, ...extra });
  const official = async row => {
    const assignment = await models.ProxyAssignment.findOne({ where: { proxyOrderId: row.id } });
    return models.Order.create({
      orderNumber: `W${++sequence}`,
      appleId: assignment.accountEmail,
      recipientName: '张三',
      recipientPhone: '13800000001',
      recipientIdLast4: '0123',
      sourceContactEmail: 'customer1@example.com',
      pickupStoreCode: 'R480',
      products: [{ name: 'iPhone Duo 星光白色 256GB', quantity: 1 }],
      orderDate: new Date(assignment.startedAt.getTime() + 1),
    });
  };

  test('无占用软删除保留物理记录、客户原文和历史，递增版本并记录唯一审计', async () => {
    const row = await createHttp();
    const before = (await rowModel(row.id)).toJSON();
    const result = await deleteHttp(row);
    expect(result.response.status).toBe(200);
    expect(result.json.data).toMatchObject({ id: row.id, version: row.version + 1, deleted: true });
    const after = (await rowModel(row.id)).toJSON();
    expect(after.deletedAt).toBeInstanceOf(Date);
    expect(after.rawText).toBe(before.rawText);
    expect(after.notes).toBe(before.notes);
    expect(after.status).toBe(before.status);
    expect(await models.ProxyOrder.unscoped().count()).toBe(1);
    const event = await models.ProxyEvent.findOne({
      where: { proxyOrderId: row.id, action: 'delete' },
    });
    expect(event.actorId).toBe(actor.id);
    expect(event.createdAt).toBeInstanceOf(Date);
  });

  test('真实JWT认证401/403及同token撤权，唯一页面read允许删除', async () => {
    const row = await createHttp();
    for (const [authentication, status] of [
      ['', 401],
      ['invalid-synthetic-token', 401],
      [otherToken, 403],
    ])
      expect(
        (await api(`/${row.id}/delete`, 'POST', { expectedVersion: row.version }, authentication))
          .response.status
      ).toBe(status);
    await models.UserPermission.destroy({
      where: { userId: actor.id, permissionCode: 'proxy_orders.read' },
    });
    expect((await deleteHttp(row)).response.status).toBe(403);
    await models.UserPermission.create({ userId: actor.id, permissionCode: 'proxy_orders.read' });
    expect((await deleteHttp(row)).response.status).toBe(200);
    expect((await other.reload()).role).toBe('operator');
  });

  test.each([0, '1', null, undefined, -1])(
    '非法expectedVersion=%p拒绝且无删除事件',
    async expectedVersion => {
      const row = await createHttp();
      expect((await deleteHttp(row, { expectedVersion })).response.status).toBe(400);
      expect((await rowModel(row.id)).deletedAt).toBeNull();
      expect(await models.ProxyEvent.count({ where: { action: 'delete' } })).toBe(0);
    }
  );

  test('合法但陈旧版本409且无副作用', async () => {
    const row = await createHttp();
    expect((await deleteHttp(row, { expectedVersion: row.version + 1 })).response.status).toBe(409);
    expect((await rowModel(row.id)).deletedAt).toBeNull();
    expect(await models.ProxyEvent.count({ where: { action: 'delete' } })).toBe(0);
  });

  test('活跃占用需明确停止确认；删除只结束占用且账号/Apple订单/关联/既有事件保持', async () => {
    const pooled = await account();
    await pooled.update({ status: '使用中', notes: '保留账号状态' });
    const row = await createHttp();
    const order = await official(row);
    await require('../src/services/proxyOrderService').reconcile();
    const current = await rowModel(row.id);
    const accountBefore = (await pooled.reload()).toJSON(),
      orderBefore = (await order.reload()).toJSON();
    const linksBefore = (await models.ProxyOrderLink.findAll()).map(link => link.toJSON());
    const eventsBefore = (await models.ProxyEvent.findAll()).map(event => event.toJSON());
    for (const confirmedStopped of [undefined, false, 'true']) {
      expect((await deleteHttp(current, { confirmedStopped })).response.status).toBe(409);
      expect((await rowModel(row.id)).deletedAt).toBeNull();
      expect(
        await models.ProxyAssignment.count({ where: { proxyOrderId: row.id, endedAt: null } })
      ).toBe(1);
    }
    expect((await deleteHttp(current, { confirmedStopped: true })).response.status).toBe(200);
    expect((await pooled.reload()).toJSON()).toEqual(accountBefore);
    expect((await order.reload()).toJSON()).toEqual(orderBefore);
    expect((await models.ProxyOrderLink.findAll()).map(link => link.toJSON())).toEqual(linksBefore);
    expect(await models.ProxyAssignment.count()).toBe(1);
    expect(await models.ProxyAssignment.count({ where: { endedAt: null } })).toBe(0);
    const previousEvents = await models.ProxyEvent.findAll({
      where: { id: eventsBefore.map(event => event.id) },
      order: [['id', 'ASC']],
    });
    expect(previousEvents.map(event => event.toJSON())).toEqual(eventsBefore);
    expect(
      (await api('/accounts?availableOnly=true')).json.data.rows.map(item => item.id)
    ).toContain(pooled.id);
  });

  test('已删列表/计数/搜索/详情/所有写操作排除，混合复制原子拒绝', async () => {
    const row = await createHttp(),
      live = await createHttp({ phone: '13800000002' });
    await deleteHttp(row);
    for (const path of ['', `?keyword=${row.id}`, '?status=pending', '?limit=1&page=2']) {
      const result = await api(path);
      expect(result.response.status).toBe(200);
      expect(result.json.data.rows.every(item => item.id !== row.id)).toBe(true);
      expect(result.json.data.count).toBe(path.includes('keyword') ? 0 : 1);
    }
    expect((await api(`/${row.id}`)).response.status).toBe(404);
    expect(
      (await api(`/${row.id}`, 'PUT', { ...payload(), expectedVersion: row.version })).response
        .status
    ).toBe(404);
    for (const action of ['notes', 'status', 'accounts', 'release', 'link', 'delete']) {
      const result = await api(`/${row.id}/${action}`, 'POST', {
        expectedVersion: row.version,
        confirmedStopped: true,
        status: 'pending',
        notes: 'not saved',
        count: 1,
        reason: 'not saved',
      });
      expect(result.response.status).toBe(404);
    }
    const beforeEvents = await models.ProxyEvent.count();
    for (const selected of [[row.id], [live.id, row.id]])
      expect((await api('/copy', 'POST', { ids: selected })).response.status).toBe(409);
    expect(await models.ProxyEvent.count()).toBe(beforeEvents);
    expect((await rowModel(live.id)).deletedAt).toBeNull();
  });

  test('删除不参与疑似重复或自动关联，保留账号历史不会重新激活已删委托', async () => {
    await account();
    const row = await createHttp();
    const order = await official(row);
    expect((await deleteHttp(row, { confirmedStopped: true })).response.status).toBe(200);
    await require('../src/services/proxyOrderService').reconcile();
    expect(await models.ProxyOrderLink.count({ where: { proxyOrderId: row.id } })).toBe(0);
    const source =
      '姓名：张三\n身份证后四位：0123\n手机号：13800000001\n邮箱：customer1@example.com\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼';
    const preview = await api('/parse', 'POST', { text: source });
    expect(preview.json.data.duplicates).toEqual([]);
    const next = await createHttp();
    expect(next.id).not.toBe(row.id);
    expect((await rowModel(row.id)).status).toBe('pending');
    expect((await order.reload()).orderNumber).toBe(order.orderNumber);
  });

  test('并发重复删除只执行一次，第二请求404，不重复审计/释放', async () => {
    await account();
    const row = await createHttp();
    const results = await Promise.all([
      deleteHttp(row, { confirmedStopped: true }),
      deleteHttp(row, { confirmedStopped: true }),
    ]);
    expect(results.filter(result => result.response.status === 200)).toHaveLength(1);
    expect(results.find(result => result.response.status !== 200).response.status).toBe(404);
    expect(
      await models.ProxyEvent.count({ where: { proxyOrderId: row.id, action: 'delete' } })
    ).toBe(1);
    expect(await models.ProxyAssignment.count()).toBe(1);
    expect(await models.ProxyAssignment.count({ where: { endedAt: null } })).toBe(0);
  });

  test('删除/分配同版本竞态不留下已删活跃占用', async () => {
    const row = await createHttp();
    await account();
    const results = await Promise.all([
      deleteHttp(row, { confirmedStopped: true }),
      api(`/${row.id}/accounts`, 'POST', { expectedVersion: row.version, count: 1 }),
    ]);
    expect(results.filter(result => result.response.status === 200)).toHaveLength(1);
    expect([404, 409]).toContain(
      results.find(result => result.response.status !== 200).response.status
    );
    const current = await rowModel(row.id);
    if (current.deletedAt)
      expect(
        await models.ProxyAssignment.count({ where: { proxyOrderId: row.id, endedAt: null } })
      ).toBe(0);
    else
      expect(
        await models.ProxyAssignment.count({ where: { proxyOrderId: row.id, endedAt: null } })
      ).toBe(1);
  });

  test('正式软删除迁移空表down/up，有删除历史拒绝down且物理记录保持', async () => {
    const migration = require('../migrations/20261016000001-soft-delete-proxy-orders');
    const queryInterface = models.sequelize.getQueryInterface();
    await migration.down(queryInterface);
    await migration.up(queryInterface);
    const row = await createHttp();
    await deleteHttp(row);
    await expect(migration.down(queryInterface)).rejects.toThrow('软删除历史');
    expect((await rowModel(row.id)).deletedAt).toBeInstanceOf(Date);
    expect(await models.ProxyOrder.unscoped().count()).toBe(1);
  });

  test('删除审计失败全部回滚：删除标记、版本、占用结束时间均保持', async () => {
    await account();
    const row = await createHttp();
    const before = (await rowModel(row.id)).toJSON();
    const assignmentBefore = (await models.ProxyAssignment.findOne()).toJSON();
    models.ProxyEvent.addHook('beforeCreate', 'independentDeleteFailure', event => {
      if (event.action === 'delete') throw new Error('synthetic deletion audit failure');
    });
    try {
      expect((await deleteHttp(row, { confirmedStopped: true })).response.status).toBe(500);
    } finally {
      models.ProxyEvent.removeHook('beforeCreate', 'independentDeleteFailure');
    }
    expect((await rowModel(row.id)).toJSON()).toEqual(before);
    expect((await models.ProxyAssignment.findOne()).toJSON()).toEqual(assignmentBefore);
    expect(await models.ProxyEvent.count({ where: { action: 'delete' } })).toBe(0);
  });
});
