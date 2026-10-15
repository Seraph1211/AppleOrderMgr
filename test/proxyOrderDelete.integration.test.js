/* eslint-disable camelcase -- SQL 契约 */
const suite = process.env.RUN_PROXY_DELETE_TEST === 'true' ? describe : describe.skip;
suite('代抢软删除真实 PostgreSQL 回归', () => {
  let models;
  let service;
  let actor;
  let serial = 8800000000;
  const payload = (extra = {}) => ({
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
    notes: '合成备注',
    rawText: '仅隔离库软删除回归',
    confirmedDuplicate: true,
    ...extra,
  });
  const create = extra => service.saveOrder(null, payload(extra), actor.id);
  const pool = async (count = 1) => {
    for (let index = 0; index < count; index++)
      await models.AppleId.create({
        appleId: `delete-${++serial}@example.com`,
        password: 'Synthetic-Password',
        isProxyPool: true,
        status: '使用中',
      });
  };
  const official = async row => {
    const assignment = await models.ProxyAssignment.findOne({ where: { proxyOrderId: row.id } });
    return models.Order.create({
      orderNumber: `W${++serial}`,
      appleId: assignment.accountEmail,
      recipientName: row.lastName + row.firstName,
      recipientPhone: row.phone,
      recipientIdLast4: row.idLast4,
      sourceContactEmail: row.email,
      pickupStoreCode: row.storeCodes[0],
      products: [{ name: 'iPhone Duo 星光白色 256GB', quantity: 1 }],
      orderDate: assignment.startedAt,
    });
  };
  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_proxy_test_20261018' ||
      process.env.DB_NAME_TEST !== process.env.DB_NAME ||
      process.env.DATABASE_URL
    )
      throw new Error('软删除回归仅允许明确隔离的20261018数据库');
    models = require('../src/models');
    service = require('../src/services/proxyOrderService');
    await models.sequelize.authenticate();
    await models.sequelize.query(
      'TRUNCATE proxy_order_links, proxy_events, proxy_assignments, proxy_orders, apple_ids, orders, users RESTART IDENTITY CASCADE'
    );
    actor = await models.User.create({
      username: 'delete_synthetic',
      password: 'Synthetic-Password',
      role: 'admin',
      status: 'active',
    });
  });
  beforeEach(async () => {
    await models.sequelize.query(
      'TRUNCATE proxy_order_links, proxy_events, proxy_assignments, proxy_orders, apple_ids, orders RESTART IDENTITY CASCADE'
    );
  });
  afterAll(async () => {
    if (models) await models.sequelize.close();
  });

  test('迁移down/up保留现有数据，删除后down拒绝且不破坏历史', async () => {
    const created = await create();
    const migration = require('../migrations/20261016000001-soft-delete-proxy-orders');
    await migration.down(models.sequelize.getQueryInterface());
    const [legacy] = await models.sequelize.query(
      'SELECT id,status,notes,raw_text FROM proxy_orders'
    );
    expect(legacy[0]).toMatchObject({ id: created.id, status: 'pending', notes: '合成备注' });
    await migration.up(models.sequelize.getQueryInterface());
    const row = await models.ProxyOrder.findByPk(created.id);
    expect(row.deletedAt).toBeNull();
    await service.deleteOrder(row.id, { expectedVersion: row.version }, actor.id);
    await expect(migration.down(models.sequelize.getQueryInterface())).rejects.toThrow(
      '禁止有损回退'
    );
    expect((await models.ProxyOrder.unscoped().findByPk(row.id)).deletedAt).not.toBeNull();
  });
  test.each(['pending', 'rushing', 'succeeded', 'cancelled'])(
    '无占用四态均可隐藏而保留原状态与历史 %s',
    async status => {
      const created = await create();
      const row = await models.ProxyOrder.findByPk(created.id);
      await row.update({ status });
      const rawBefore = row.getDataValue('rawText');
      expect(await service.deleteOrder(row.id, { expectedVersion: row.version }, actor.id)).toEqual(
        { id: row.id, version: row.version + 1, deleted: true }
      );
      expect(await models.ProxyOrder.findByPk(row.id)).toBeNull();
      const hidden = await models.ProxyOrder.unscoped().findByPk(row.id);
      expect(hidden.status).toBe(status);
      expect(hidden.getDataValue('rawText')).toBe(rawBefore);
      expect(hidden.notes).toBe(row.notes);
      expect(
        await models.ProxyEvent.count({ where: { proxyOrderId: row.id, action: 'delete' } })
      ).toBe(1);
      expect(
        await models.ProxyEvent.count({ where: { proxyOrderId: row.id, action: 'release' } })
      ).toBe(0);
    }
  );
  test('活跃占用需严格true停抢确认，确认删除保留账号状态及所有关联', async () => {
    await pool();
    const created = await create();
    const row = await models.ProxyOrder.findByPk(created.id);
    const order = await official(row);
    await service.reconcile();
    await row.reload();
    for (const confirmedStopped of [undefined, false, 'true', 1])
      await expect(
        service.deleteOrder(row.id, { expectedVersion: row.version, confirmedStopped }, actor.id)
      ).rejects.toMatchObject({ statusCode: 409 });
    const assignment = await models.ProxyAssignment.findOne();
    const account = await models.AppleId.findByPk(assignment.appleIdRef);
    await service.deleteOrder(
      row.id,
      { expectedVersion: row.version, confirmedStopped: true },
      actor.id
    );
    expect((await assignment.reload()).endedAt).not.toBeNull();
    expect((await account.reload()).status).toBe('使用中');
    expect(await models.ProxyAssignment.count()).toBe(1);
    expect(await models.ProxyOrderLink.count({ where: { orderId: order.id } })).toBe(1);
    expect(await models.Order.findByPk(order.id)).not.toBeNull();
    expect(await models.ProxyEvent.count({ where: { action: 'release', actorId: actor.id } })).toBe(
      1
    );
    expect(await models.ProxyEvent.count({ where: { action: 'delete', actorId: actor.id } })).toBe(
      1
    );
    expect((await service.listAccounts({ availableOnly: 'true' })).availableCount).toBe(1);
  });
  test('所有普通查询/编辑/动作排除已删除，复制混入已删整批拒绝且不记录copy', async () => {
    await pool(2);
    const removed = await create({ platformOrderNumber: 'delete-synthetic' });
    const active = await create({ firstName: '另一位' });
    await service.deleteOrder(
      removed.id,
      { expectedVersion: removed.version, confirmedStopped: true },
      actor.id
    );
    expect((await service.listOrders({})).count).toBe(1);
    expect((await service.listOrders({ keyword: 'delete-synthetic' })).count).toBe(0);
    await expect(service.detail(removed.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.saveOrder(removed.id, { ...payload(), expectedVersion: 2 }, actor.id)
    ).rejects.toMatchObject({ statusCode: 404 });
    for (const action of ['status', 'notes', 'accounts', 'release', 'link'])
      await expect(
        service.changeOrder(action, removed.id, { expectedVersion: 2 }, actor.id)
      ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.deleteOrder(removed.id, { expectedVersion: 2 }, actor.id)
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.copyTemplates([active.id, removed.id], actor.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await models.ProxyEvent.count({ where: { action: 'copy' } })).toBe(0);
    const preview = await service.parseText(
      '姓名：合成\n手机号：13800000000\n邮箱：synthetic@example.com\n身份证后四位：000X\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：闲鱼'
    );
    expect(preview.duplicates).toEqual([]);
  });
  test('已删除不参与新官方订单自动匹配或改变版本', async () => {
    await pool();
    const created = await create();
    const row = await models.ProxyOrder.findByPk(created.id);
    await official(row);
    await service.deleteOrder(
      row.id,
      { expectedVersion: row.version, confirmedStopped: true },
      actor.id
    );
    await service.reconcile();
    const hidden = await models.ProxyOrder.unscoped().findByPk(row.id);
    expect(hidden.version).toBe(2);
    expect(hidden.status).toBe('pending');
    expect(await models.ProxyOrderLink.count()).toBe(0);
  });
  test('并发重复删除仅一次提交；删除与分配同版本不产生新遗留占用', async () => {
    const created = await create();
    const results = await Promise.allSettled(
      [1, 2].map(() => service.deleteOrder(created.id, { expectedVersion: 1 }, actor.id))
    );
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason.statusCode).toBe(404);
    expect(await models.ProxyEvent.count({ where: { action: 'delete' } })).toBe(1);
    const concurrent = await create();
    await pool();
    const actions = await Promise.allSettled([
      service.deleteOrder(concurrent.id, { expectedVersion: 1, confirmedStopped: true }, actor.id),
      service.changeOrder('accounts', concurrent.id, { expectedVersion: 1, count: 1 }, actor.id),
    ]);
    expect(actions.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const row = await models.ProxyOrder.unscoped().findByPk(concurrent.id);
    if (row.deletedAt)
      expect(
        await models.ProxyAssignment.count({ where: { proxyOrderId: row.id, endedAt: null } })
      ).toBe(0);
  });
  test('delete审计失败回滚删除、释放、版本及release事件', async () => {
    await pool();
    const created = await create();
    const original = models.ProxyEvent.create.bind(models.ProxyEvent);
    const hook = jest
      .spyOn(models.ProxyEvent, 'create')
      .mockImplementation((values, options) =>
        values.action === 'delete'
          ? Promise.reject(new Error('synthetic-delete-audit-failure'))
          : original(values, options)
      );
    try {
      await expect(
        service.deleteOrder(created.id, { expectedVersion: 1, confirmedStopped: true }, actor.id)
      ).rejects.toThrow('synthetic-delete-audit-failure');
    } finally {
      hook.mockRestore();
    }
    expect((await models.ProxyOrder.findByPk(created.id)).version).toBe(1);
    expect(await models.ProxyAssignment.count({ where: { endedAt: null } })).toBe(1);
    expect(await models.ProxyEvent.count({ where: { action: 'release' } })).toBe(0);
    expect(await models.ProxyEvent.count({ where: { action: 'delete' } })).toBe(0);
  });
  test.each([0, -1, 1.5, '1', true, null, undefined])(
    '非法版本拒绝且不改变记录 %#',
    async expectedVersion => {
      const created = await create();
      await expect(
        service.deleteOrder(created.id, { expectedVersion }, actor.id)
      ).rejects.toMatchObject({ statusCode: 400 });
      expect((await models.ProxyOrder.findByPk(created.id)).version).toBe(1);
    }
  );
});
