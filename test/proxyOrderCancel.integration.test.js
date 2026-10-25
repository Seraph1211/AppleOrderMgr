/* eslint-disable camelcase -- 隔离 PostgreSQL 契约 */
const suite = process.env.RUN_PROXY_CANCEL_TEST === 'true' ? describe : describe.skip;

suite('代抢取消与释放真实 PostgreSQL/API 回归', () => {
  let models, service, actor, server, origin;
  let sequence = 0;
  const payload = () => ({
    lastName: '合',
    firstName: '成',
    phone: '13800000000',
    email: 'synthetic@example.com',
    idLast4: '000X',
    orderSource: '闲鱼',
    productModel: 'Duo',
    color: '白',
    storage: '256GB',
    storeCity: '重庆',
    storeMode: 'city_any',
    quantity: 1,
    notes: '保留客户备注',
    rawText: '仅隔离库取消释放回归',
    confirmedDuplicate: true,
  });
  const account = (status = '使用中') =>
    models.AppleId.create({
      appleId: `cancel-${++sequence}@example.com`,
      password: 'Synthetic-Password',
      notes: '保留账号备注',
      isProxyPool: true,
      status,
    });
  const create = async () => {
    const saved = await service.saveOrder(null, payload(), actor.id);
    return models.ProxyOrder.findByPk(saved.id);
  };
  const cancel = (row, extra = {}, permission = 'proxy_orders.read') =>
    fetch(`${origin}/${row.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-permissions': permission },
      body: JSON.stringify({ expectedVersion: row.version, status: 'cancelled', ...extra }),
    });
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_proxy_cancel_test_20261025' ||
      process.env.DB_NAME_TEST !== process.env.DB_NAME ||
      process.env.DATABASE_URL
    )
      throw new Error('取消回归仅允许明确隔离测试库且 DB_NAME_TEST 相同，禁止 DATABASE_URL');
    models = require('../src/models');
    service = require('../src/services/proxyOrderService');
    await models.sequelize.authenticate();
    await models.sequelize.query(
      'TRUNCATE proxy_order_links, proxy_events, proxy_assignments, proxy_orders, apple_ids, orders, users RESTART IDENTITY CASCADE'
    );
    actor = await models.User.create({
      username: 'cancel_synthetic',
      password: 'Synthetic-Password',
      role: 'admin',
      status: 'active',
    });
    const app = require('express')();
    app.use(require('express').json());
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
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) await models.sequelize.close();
  });

  test('无占用无需确认取消，仅历史已释放记录也无需确认', async () => {
    const row = await create();
    let response = await cancel(row);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ id: row.id, version: 2, released: 0 });
    await row.reload();
    expect(row.status).toBe('cancelled');
    const savedAccount = await account();
    const history = await models.ProxyAssignment.create({
      proxyOrderId: row.id,
      appleIdRef: savedAccount.id,
      accountEmail: savedAccount.appleId,
      startedAt: new Date(0),
      endedAt: new Date(1000),
      actorId: actor.id,
    });
    response = await cancel(row);
    expect(response.status).toBe(200);
    expect((await history.reload()).endedAt.getTime()).toBe(1000);
    expect(await models.ProxyEvent.count({ where: { action: 'release' } })).toBe(0);
  });
  test.each([undefined, false, 'true', 1])(
    '有占用拒绝非明确true确认 %p，状态与占用不变',
    async confirmedStopped => {
      await account();
      const row = await create();
      const response = await cancel(row, { confirmedStopped });
      expect(response.status).toBe(409);
      expect((await response.json()).error.details.requiresStoppedConfirmation).toBe(true);
      expect((await row.reload()).status).toBe('pending');
      expect(row.version).toBe(1);
      expect(await models.ProxyAssignment.count({ where: { endedAt: null } })).toBe(1);
      expect(await models.ProxyEvent.count({ where: { action: ['release', 'status'] } })).toBe(0);
    }
  );
  test('确认后全部释放，保留备注密码原文与分配历史，账号可重新分配', async () => {
    const first = await account();
    const row = await create();
    const second = await account();
    await service.changeOrder(
      'accounts',
      row.id,
      { expectedVersion: row.version, count: 1 },
      actor.id
    );
    await row.reload();
    const rawBefore = row.getDataValue('rawText');
    const result = await cancel(row, { confirmedStopped: true, reason: '客户取消' });
    expect(result.status).toBe(200);
    expect((await result.json()).data.released).toBe(2);
    await row.reload();
    expect(row.status).toBe('cancelled');
    expect(row.version).toBe(3);
    expect(row.notes).toBe('保留客户备注');
    expect(row.getDataValue('rawText')).toBe(rawBefore);
    expect(await models.ProxyAssignment.count()).toBe(2);
    expect(await models.ProxyAssignment.count({ where: { endedAt: null } })).toBe(0);
    for (const savedAccount of [first, second]) {
      await savedAccount.reload();
      expect(savedAccount.status).toBe('未使用');
      expect(savedAccount.notes).toBe('保留账号备注');
      expect(savedAccount.password).toBe('Synthetic-Password');
    }
    const release = await models.ProxyEvent.findOne({ where: { action: 'release' } });
    expect(release.detail.source).toBe('cancel');
    expect(release.detail.assignmentIds).toHaveLength(2);
    const status = await models.ProxyEvent.findOne({ where: { action: 'status' } });
    expect(status.detail).toMatchObject({ from: 'pending', to: 'cancelled' });
    expect(JSON.stringify(status.detail)).not.toContain('客户取消');
    expect((await service.listAccounts({ availableOnly: true })).availableCount).toBe(2);
    const next = await create();
    expect(
      await models.ProxyAssignment.count({ where: { proxyOrderId: next.id, endedAt: null } })
    ).toBe(1);
  });
  test.each(['异常', '已下架', '未使用'])(
    '释放不覆盖其他账号状态 %s，不影响另一单',
    async status => {
      const first = await account();
      const row = await create();
      await first.update({ status });
      await account();
      const other = await create();
      expect((await cancel(row, { confirmedStopped: true })).status).toBe(200);
      expect((await first.reload()).status).toBe(status);
      expect(
        await models.ProxyAssignment.count({ where: { proxyOrderId: other.id, endedAt: null } })
      ).toBe(1);
    }
  );
  test('权限及过期版本均不能取消或释放，同版本并发只成功一次', async () => {
    await account();
    const row = await create();
    expect((await cancel(row, { confirmedStopped: true }, '')).status).toBe(403);
    expect((await cancel(row, { expectedVersion: 999, confirmedStopped: true })).status).toBe(409);
    expect(await models.ProxyAssignment.count({ where: { endedAt: null } })).toBe(1);
    const results = await Promise.all([
      cancel(row, { confirmedStopped: true }),
      cancel(row, { confirmedStopped: true }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(await models.ProxyEvent.count({ where: { action: 'release' } })).toBe(1);
  });
  test('状态审计失败回滚取消、占用、账号状态及释放审计', async () => {
    const savedAccount = await account();
    const row = await create();
    const original = models.ProxyEvent.create.bind(models.ProxyEvent);
    jest.spyOn(models.ProxyEvent, 'create').mockImplementation((values, options) => {
      if (values.action === 'status') throw new Error('合成审计写入失败');
      return original(values, options);
    });
    await expect(
      service.changeOrder(
        'status',
        row.id,
        { expectedVersion: row.version, status: 'cancelled', confirmedStopped: true },
        actor.id
      )
    ).rejects.toThrow('合成审计写入失败');
    expect((await row.reload()).status).toBe('pending');
    expect(row.version).toBe(1);
    expect((await savedAccount.reload()).status).toBe('使用中');
    expect(await models.ProxyAssignment.count({ where: { endedAt: null } })).toBe(1);
    expect(await models.ProxyEvent.count({ where: { action: ['release', 'status'] } })).toBe(0);
  });
  test('成功状态仍不释放，历史已取消单不被其他操作批量清理', async () => {
    await account();
    const row = await create();
    await row.update({ status: 'cancelled' });
    await service.changeOrder(
      'notes',
      row.id,
      { expectedVersion: row.version, notes: '核对' },
      actor.id
    );
    await row.reload();
    await service.changeOrder(
      'status',
      row.id,
      { expectedVersion: row.version, status: 'succeeded' },
      actor.id
    );
    expect(await models.ProxyAssignment.count({ where: { endedAt: null } })).toBe(1);
    expect(await models.ProxyEvent.count({ where: { action: 'release' } })).toBe(0);
  });
});
