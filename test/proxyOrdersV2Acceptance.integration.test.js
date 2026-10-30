/* eslint-disable camelcase -- 隔离 PostgreSQL 契约 */
const suite = process.env.RUN_PROXY_V2_ACCEPTANCE === 'true' ? describe : describe.skip;

suite('代抢二期独立真实 PostgreSQL/API 验收', () => {
  let models, service, actor, server, origin;
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
  const create = async (extra = {}) => {
    const saved = await service.saveOrder(null, payload(extra), actor.id);
    return models.ProxyOrder.findByPk(saved.id);
  };
  const account = () =>
    models.AppleId.create({
      appleId: `acceptance-${++sequence}@example.com`,
      password: 'Synthetic-V2-Pass',
      isProxyPool: true,
    });
  const change = async (row, action, body) => {
    await row.reload();
    return service.changeOrder(action, row.id, { expectedVersion: row.version, ...body }, actor.id);
  };
  const official = async (row, extra = {}) => {
    const assignment = await models.ProxyAssignment.findOne({ where: { proxyOrderId: row.id } });
    return models.Order.create({
      orderNumber: `W${++sequence}`,
      appleId: assignment.accountEmail,
      recipientName: row.lastName + row.firstName,
      recipientPhone: row.phone,
      recipientIdLast4: row.idLast4,
      sourceContactEmail: row.email,
      pickupStoreCode: 'R480',
      pickupStore: 'Apple 重庆解放碑',
      products: [{ name: 'iPhone Duo 256GB 星光白色', quantity: 1 }],
      orderDate: new Date(assignment.startedAt.getTime() + 1),
      ...extra,
    });
  };
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
      process.env.DB_NAME !== 'apple_order_mgr_proxy_test_20261016' ||
      process.env.DB_NAME_TEST !== process.env.DB_NAME ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许显式独立代抢二期测试库且 DB_NAME_TEST 相同，禁止 DATABASE_URL');
    models = require('../src/models');
    service = require('../src/services/proxyOrderService');
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

  test('空池、平台号重复、客户原文加密与普通 DTO 密码隔离', async () => {
    const first = await create({ platformOrderNumber: 'SYNTHETIC-SPLIT' });
    const second = await create({ platformOrderNumber: 'SYNTHETIC-SPLIT', phone: '13800000002' });
    expect(first.id).not.toBe(second.id);
    expect(await models.ProxyAssignment.count()).toBe(0);
    const [raw] = await models.sequelize.query('SELECT raw_text FROM proxy_orders');
    expect(raw.every(row => !row.raw_text.includes('独立合成原文'))).toBe(true);
    const details = await service.detail(first.id);
    expect(details.rawText).toBe('独立合成原文');
    expect(JSON.stringify(await service.listOrders({}))).not.toContain('Synthetic-V2-Pass');
  });

  test('疑似重复需明确继续、复制仅当前占用账号且接口no-store、资料DTO无密码', async () => {
    await account();
    const first = await create();
    await expect(create()).rejects.toMatchObject({ statusCode: 409 });
    const second = await create({ confirmedDuplicate: true });
    expect(second.id).not.toBe(first.id);
    const response = await api('/copy', 'POST', { ids: [first.id] });
    expect(response.response.status).toBe(200);
    expect(response.response.headers.get('cache-control')).toContain('no-store');
    expect(response.json.data.count).toBe(1);
    expect(response.json.data.text.split(',')[1]).toBe('Synthetic-V2-Pass');
    for (const path of ['', `/${first.id}`, '/accounts']) {
      const result = await api(path);
      expect(result.response.status).toBe(200);
      expect(JSON.stringify(result.json)).not.toContain('Synthetic-V2-Pass');
      expect(result.response.headers.get('cache-control')).toContain('no-store');
    }
  });

  test('自动多关联幂等，人工恢复防旧关联覆盖，新关联重新成功，取消保留', async () => {
    await account();
    const row = await create();
    const first = await official(row);
    await service.reconcile();
    expect((await row.reload()).status).toBe('succeeded');
    await change(row, 'status', { status: 'pending' });
    await service.reconcile();
    expect((await row.reload()).status).toBe('pending');
    await change(row, 'notes', { notes: '人工恢复，继续抢购' });
    await service.reconcile();
    expect((await row.reload()).status).toBe('pending');
    const second = await official(row);
    await service.reconcile();
    await service.reconcile();
    expect((await row.reload()).status).toBe('succeeded');
    expect((await service.detail(row.id)).officialOrders.map(order => order.id).sort()).toEqual(
      [first.id, second.id].sort()
    );
    await first.update({ emailOrderStatus: 'cancelled' });
    await service.reconcile();
    expect((await row.reload()).status).toBe('succeeded');
    await change(row, 'status', { status: 'cancelled', confirmedStopped: true });
    const third = await official(row);
    await service.reconcile();
    expect((await row.reload()).status).toBe('cancelled');
    expect((await service.detail(row.id)).officialOrders.map(order => order.id)).toContain(
      third.id
    );
    expect(await models.ProxyAssignment.count({ where: { endedAt: null } })).toBe(0);
  });

  test('四态任意恢复及原因审计，不强制额外重抢表单，不覆盖客户备注', async () => {
    const row = await create();
    for (const from of ['pending', 'rushing', 'succeeded', 'cancelled']) {
      await change(row, 'status', { status: from });
      for (const to of ['pending', 'rushing', 'succeeded', 'cancelled']) {
        await change(row, 'status', { status: to });
        expect((await row.reload()).status).toBe(to);
      }
    }
    expect(row.notes).toBe('只能10.24～10.25取货');
    await change(row, 'status', { status: 'cancelled', reason: '工作人员确认恢复前先停止' });
    const lastEvent = await models.ProxyEvent.findOne({
      where: { proxyOrderId: row.id, action: 'status' },
      order: [['id', 'DESC']],
    });
    expect(lastEvent.detail).toMatchObject({
      from: 'cancelled',
      to: 'cancelled',
      source: 'manual',
    });
    expect(require('../src/utils/fieldEncryption').decrypt(lastEvent.detail.reasonEncrypted)).toBe(
      '工作人员确认恢复前先停止'
    );
    const events = await models.ProxyEvent.findAll({ where: { proxyOrderId: row.id } });
    expect(events.length).toBeGreaterThan(10);
    expect(events.every(event => event.actorId === actor.id)).toBe(true);
  });

  test('人工关联抢错商品，解除留痕且不自动重连；跨客户拒绝', async () => {
    await account();
    const row = await create();
    const order = await official(row, {
      products: [{ name: 'iPhone 18 Pro Max 512GB 黑色', quantity: 1 }],
    });
    await service.reconcile();
    expect((await service.detail(row.id)).officialOrders).toHaveLength(0);
    await change(row, 'link', { orderNumber: order.orderNumber, reason: '抢错商品，保留证据' });
    expect((await service.detail(row.id)).officialOrders).toHaveLength(1);
    expect((await row.reload()).status).toBe('pending');
    await change(row, 'link', { orderNumber: null, orderId: order.id, reason: '解除误关联' });
    await order.update({ products: [{ name: 'iPhone Duo 256GB 星光白色', quantity: 1 }] });
    await service.reconcile();
    const details = await service.detail(row.id);
    expect(details.officialOrders).toHaveLength(0);
    expect(details.links.length).toBeGreaterThan(0);
    await order.update({ recipientName: '李四' });
    await expect(
      change(row, 'link', { orderNumber: order.orderNumber, reason: '跨客户校验' })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('编辑委托保留Apple订单、占用和关联历史；同官方订单不跨委托', async () => {
    await account();
    const row = await create();
    const order = await official(row);
    await service.reconcile();
    await row.reload();
    const officialBefore = (await order.reload()).toJSON();
    const assignmentBefore = (await models.ProxyAssignment.findOne()).toJSON();
    const linkBefore = (await models.ProxyOrderLink.findOne()).toJSON();
    await service.saveOrder(
      row.id,
      {
        ...row.toJSON(),
        expectedVersion: row.version,
        firstName: '新名',
        notes: '人工编辑客户信息',
      },
      actor.id
    );
    expect((await order.reload()).toJSON()).toEqual(officialBefore);
    expect((await models.ProxyAssignment.findOne()).toJSON()).toEqual(assignmentBefore);
    expect((await models.ProxyOrderLink.findOne()).toJSON()).toEqual(linkBefore);
    const other = await create({ phone: '13800000003' });
    await expect(
      models.ProxyOrderLink.create({
        proxyOrderId: other.id,
        orderId: order.id,
        source: 'manual',
        actorId: actor.id,
        linkedAt: new Date(),
      })
    ).rejects.toThrow();
    expect(await models.ProxyOrderLink.count()).toBe(1);
  });

  test('并发追加仅一单能占用同一账号，确认停止才能释放且历史保留', async () => {
    const x = await create(),
      y = await create({ confirmedDuplicate: true });
    const pooled = await account();
    const results = await Promise.allSettled(
      [x, y].map(row => change(row, 'accounts', { accountIds: [pooled.id] }))
    );
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const assignment = await models.ProxyAssignment.findOne();
    const winner = await models.ProxyOrder.findByPk(assignment.proxyOrderId);
    await expect(
      change(winner, 'release', { assignmentIds: [assignment.id] })
    ).rejects.toMatchObject({ statusCode: 400 });
    await change(winner, 'release', { assignmentIds: [assignment.id], confirmedStopped: true });
    expect((await assignment.reload()).endedAt).not.toBeNull();
    expect(await models.ProxyAssignment.count()).toBe(1);
  });

  test('撤销唯一read后旧细分权限不再产生隐式授权', async () => {
    const user = await models.User.create({
      username: `revoke_${Date.now()}`,
      password: 'Synthetic-V2-User',
      role: 'operator',
      status: 'active',
    });
    await models.UserPermission.bulkCreate([
      { userId: user.id, permissionCode: 'proxy_orders.read' },
      { userId: user.id, permissionCode: 'proxy_orders.copy' },
    ]);
    const permissions = require('../src/services/permissionService');
    expect(await permissions.getEffectivePermissions(user)).toContain('proxy_orders.read');
    await models.UserPermission.destroy({
      where: { userId: user.id, permissionCode: 'proxy_orders.read' },
    });
    const after = await permissions.getEffectivePermissions(user);
    expect(after).not.toContain('proxy_orders.read');
    expect((await api('', 'GET', undefined, after.join(','))).response.status).toBe(403);
  });

  test('正式迁移空表down/up、历史单回填及二期数据安全down拒绝', async () => {
    const migration = require('../migrations/20261015000003-proxy-orders-v2');
    const queryInterface = models.sequelize.getQueryInterface();
    await migration.down(queryInterface);
    await migration.up(queryInterface);
    await account();
    const row = await create();
    const order = await official(row);
    await row.update({ orderSource: null, orderId: order.id, status: 'rushing' });
    const before = row.toJSON();
    const assignment = (await models.ProxyAssignment.findOne()).toJSON();
    const eventCount = await models.ProxyEvent.count();
    await migration.down(queryInterface);
    const legacyUser = await models.User.create({
      username: `legacy_${Date.now()}`,
      password: 'Synthetic-Legacy-User',
      role: 'operator',
      status: 'active',
    });
    await models.UserPermission.create({
      userId: legacyUser.id,
      permissionCode: 'proxy_orders.copy',
    });
    await migration.up(queryInterface);
    const migratedPermissions =
      await require('../src/services/permissionService').getEffectivePermissions(legacyUser);
    expect(migratedPermissions).toContain('proxy_orders.read');
    expect(
      migratedPermissions.filter(permission => !permission.startsWith('proxy_orders.'))
    ).toEqual([]);
    await row.reload();
    expect(row.status).toBe('rushing');
    expect(row.notes).toBe(before.notes);
    expect(row.rawText).toBe(before.rawText);
    expect(row.orderSource).toBeNull();
    expect(row.productCandidates).toEqual([
      { productModel: before.productModel, color: before.color, storage: before.storage },
    ]);
    expect((await models.ProxyAssignment.findOne()).toJSON()).toEqual(assignment);
    expect(await models.ProxyEvent.count()).toBe(eventCount);
    expect((await models.ProxyOrderLink.findOne()).source).toBe('legacy');
    expect((await service.detail(row.id)).officialOrders[0].id).toBe(order.id);
    await row.update({ orderSource: '闲鱼' });
    await expect(migration.down(queryInterface)).rejects.toThrow('二期业务数据');
    expect(await models.ProxyOrderLink.count()).toBe(1);
    expect((await row.reload()).orderSource).toBe('闲鱼');
  });

  test('统一页面权限允许全部接口，无权限及仅旧细分权限均拒绝', async () => {
    const endpoints = [
      ['/stores'],
      ['/catalog'],
      ['/parse', 'POST', { text: '姓名：张三' }],
      ['/address', 'POST', { storeCode: 'R480' }],
      ['/accounts'],
      [''],
      ['/copy', 'POST', { ids: [] }],
      ['/accounts/import', 'POST', { text: '' }],
      ['/1/status', 'POST', { status: 'pending', expectedVersion: 1 }],
      ['/1/notes', 'POST', { notes: '', expectedVersion: 1 }],
      ['/1/link', 'POST', { orderNumber: null, reason: 'test', expectedVersion: 1 }],
    ];
    for (const endpoint of endpoints) {
      const granted = await api(...endpoint);
      expect(granted.response.status).not.toBe(403);
      for (const permission of [
        '',
        'proxy_orders.edit,proxy_orders.copy,proxy_orders.accounts,proxy_orders.status,proxy_orders.link',
      ]) {
        const denied = await api(endpoint[0], endpoint[1], endpoint[2], permission);
        expect(denied.response.status).toBe(403);
      }
    }
    const read = await api('');
    expect(read.response.headers.get('cache-control')).toContain('no-store');
  });
});
