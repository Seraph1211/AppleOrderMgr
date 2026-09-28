/* eslint-disable camelcase -- SQL 契约 */
const suite = process.env.RUN_PROXY_TEST === 'true' ? describe : describe.skip;
suite('代抢管理真实 PostgreSQL/API 回归', () => {
  let m,
    service,
    actor,
    server,
    base,
    nextNumber = 8000000000;
  const payload = (extra = {}) => ({
    lastName: '张',
    firstName: '三',
    phone: '13800000000',
    email: 'customer@example.com',
    idLast4: '0020',
    productModel: 'iPhone 18 Pro Max',
    color: '酒红色',
    storage: '256GB',
    quantity: 1,
    storeCodes: ['R572'],
    storeMode: 'selected',
    billing: {
      province: '河南',
      city: '郑州',
      district: '二七区',
      streetAddress: '建设路1号',
      referenceStoreCode: 'R572',
    },
    rawText: '合成客户原文',
    notes: '',
    ...extra,
  });
  const pool = async (n = 1, extra = {}) => {
    const result = [];
    for (let i = 0; i < n; i++)
      result.push(
        await m.AppleId.create({
          appleId: `proxy-${++nextNumber}@example.com`,
          password: 'Synthetic-Pass',
          isProxyPool: true,
          ...extra,
        })
      );
    return result;
  };
  const create = async extra => {
    const row = await service.saveOrder(null, payload(extra), actor.id);
    return m.ProxyOrder.findByPk(row.id);
  };
  const official = async (request, extra = {}) => {
    const assignment = await m.ProxyAssignment.findOne({ where: { proxyOrderId: request.id } });
    return m.Order.create({
      orderNumber: `W${++nextNumber}`,
      appleId: assignment.accountEmail,
      recipientName: request.lastName + request.firstName,
      recipientPhone: request.phone,
      recipientIdLast4: request.idLast4,
      sourceContactEmail: request.email,
      pickupStoreCode: 'R572',
      pickupStore: 'Apple 郑州万象城',
      products: [{ name: 'iPhone 18 Pro Max 256GB 勃艮第酒红色', quantity: 1 }],
      orderDate: new Date(assignment.startedAt.getTime() + 1),
      ...extra,
    });
  };
  beforeAll(async () => {
    if (
      !/^apple_order_mgr_proxy_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许隔离代抢测试库');
    m = require('../src/models');
    service = require('../src/services/proxyOrderService');
    await m.sequelize.authenticate();
    await m.sequelize.query(
      'TRUNCATE proxy_events, proxy_assignments, proxy_orders, recipients, apple_ids, orders, users RESTART IDENTITY CASCADE'
    );
    const migration = require('../migrations/20260928000002-add-proxy-orders');
    await migration.down(m.sequelize.getQueryInterface());
    await migration.up(m.sequelize.getQueryInterface());
    actor = await m.User.create({
      username: 'proxy_synthetic',
      password: 'Synthetic-Password',
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
    base = `http://127.0.0.1:${server.address().port}/api/proxy-orders`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (m) await m.sequelize.close();
  });
  beforeEach(async () => {
    await m.sequelize.query(
      'TRUNCATE proxy_events, proxy_assignments, proxy_orders, recipients, apple_ids, orders RESTART IDENTITY CASCADE'
    );
  });
  test('空池允许登记；缺资料拒绝；原文加密；平台号唯一及原子回滚', async () => {
    const row = await create({ platformOrderNumber: 'platform-1' });
    expect(row.status).toBe('pending');
    expect(await m.ProxyAssignment.count()).toBe(0);
    const [raw] = await m.sequelize.query('SELECT raw_text FROM proxy_orders');
    expect(raw[0].raw_text).not.toContain('合成客户原文');
    expect(row.rawText).toBe('合成客户原文');
    await expect(create({ platformOrderNumber: 'platform-1' })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(create({ phone: 'bad' })).rejects.toMatchObject({ statusCode: 400 });
    expect(await m.ProxyOrder.count()).toBe(1);
    expect(await m.ProxyEvent.count()).toBe(1);
  });
  test('默认占用、自动追加、多行模板且复制不改状态；池状态不覆盖历史', async () => {
    await pool(3);
    const row = await create();
    expect(await m.ProxyAssignment.count()).toBe(1);
    await service.changeOrder(
      'accounts',
      row.id,
      { expectedVersion: row.version, count: 2 },
      actor.id
    );
    const copied = await service.copyTemplates([row.id], actor.id);
    expect(copied.count).toBe(3);
    expect(copied.text.split('\n')).toHaveLength(3);
    expect(copied.text).toContain(',0020,代抢 网店,,,');
    expect((await row.reload()).status).toBe('pending');
    const list = await service.listAccounts({});
    expect(JSON.stringify(list)).not.toContain('Synthetic-Pass');
    expect(list.rows.every(a => a.assignment)).toBe(true);
  });
  test('两个委托并发抢占账号只有一个成功；版本冲突拒绝', async () => {
    const x = await create(),
      y = await create();
    const [account] = await pool();
    const result = await Promise.allSettled(
      [x, y].map(r =>
        service.changeOrder(
          'accounts',
          r.id,
          { expectedVersion: r.version, accountIds: [account.id] },
          actor.id
        )
      )
    );
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await m.ProxyAssignment.count()).toBe(1);
    const winner = await m.ProxyAssignment.findOne();
    await expect(
      service.changeOrder(
        'status',
        winner.proxyOrderId,
        { expectedVersion: 1, status: 'rushing' },
        actor.id
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  test('专用池数据库约束阻止普通绑定；普通已绑定账号不能纳入', async () => {
    const [special] = await pool();
    await expect(
      m.Recipient.create({
        lastName: '李',
        firstName: '四',
        idCardNumber: '110101199001010021',
        appleIdRef: special.id,
      })
    ).rejects.toThrow();
    const [ordinary] = await pool(1, { isProxyPool: false, notes: '代抢候选' });
    await m.Recipient.create({
      lastName: '李',
      firstName: '四',
      idCardNumber: '110101199001010022',
      appleIdRef: ordinary.id,
    });
    await expect(
      service.changeAccounts('adopt', { ids: [ordinary.id] }, actor.id)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await ordinary.reload()).isProxyPool).toBe(false);
    const candidates = await service.listAccounts({ scope: 'candidates' });
    expect(candidates.rows[0].boundRecipient).toBe(true);
  });
  test('人工停止释放不靠账号状态；异常账号释放后保持异常', async () => {
    await pool();
    const row = await create();
    const assignment = await m.ProxyAssignment.findOne();
    await m.AppleId.update({ status: '异常' }, { where: { id: assignment.appleIdRef } });
    await expect(service.copyTemplates([row.id], actor.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      service.changeOrder(
        'release',
        row.id,
        { expectedVersion: row.version, assignmentIds: [assignment.id] },
        actor.id
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    await service.changeOrder(
      'release',
      row.id,
      { expectedVersion: row.version, assignmentIds: [assignment.id], confirmedStopped: true },
      actor.id
    );
    expect((await assignment.reload()).endedAt).not.toBeNull();
    expect((await m.AppleId.findByPk(assignment.appleIdRef)).status).toBe('异常');
    expect(await m.ProxyAssignment.count()).toBe(1);
  });
  test('自动关联未付款官方订单，幂等；官方取消不回退；不自动释放', async () => {
    await pool();
    const row = await create();
    const order = await official(row);
    await service.reconcile();
    await service.reconcile();
    expect((await row.reload()).status).toBe('succeeded');
    expect(row.orderId).toBe(order.id);
    expect(await m.ProxyEvent.count({ where: { action: 'auto_link' } })).toBe(1);
    await order.update({ emailOrderStatus: 'cancelled' });
    await service.reconcile();
    expect((await row.reload()).status).toBe('succeeded');
    expect(await m.ProxyAssignment.count({ where: { endedAt: null } })).toBe(1);
    await expect(
      service.changeOrder(
        'status',
        row.id,
        { expectedVersion: row.version, status: 'pending' },
        actor.id
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.copyTemplates([row.id], actor.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  test('取消后晚到官方订单保留取消并提示；人员不能直接置成功', async () => {
    await pool();
    const row = await create();
    await expect(
      service.changeOrder(
        'status',
        row.id,
        { expectedVersion: row.version, status: 'succeeded' },
        actor.id
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    await service.changeOrder(
      'status',
      row.id,
      { expectedVersion: row.version, status: 'cancelled' },
      actor.id
    );
    await official(row);
    await service.reconcile();
    expect((await row.reload()).status).toBe('cancelled');
    expect(row.orderId).toBeTruthy();
    expect(row.anomaly).toContain('已取消');
    await expect(
      service.changeOrder('accounts', row.id, { expectedVersion: row.version, count: 1 }, actor.id)
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  test('账号复用后不关联旧单；多账号多结果只关联第一笔', async () => {
    await pool(2);
    const row = await create();
    await service.changeOrder(
      'accounts',
      row.id,
      { expectedVersion: row.version, count: 1 },
      actor.id
    );
    const first = await official(row);
    await official(row, { orderDate: new Date(Date.now() + 1000) });
    await service.reconcile();
    expect((await row.reload()).orderId).toBe(first.id);
    expect(row.anomaly).toContain('多个');
    const a = await m.ProxyAssignment.findOne();
    await service.changeOrder(
      'release',
      row.id,
      { expectedVersion: row.version, assignmentIds: [a.id], confirmedStopped: true },
      actor.id
    );
    const again = await create();
    await service.reconcile();
    expect((await again.reload()).orderId).toBeNull();
  });
  test('人工关联特殊需求，纠错留痕且不自动重连；禁止跨客户', async () => {
    await pool();
    const row = await create();
    const order = await official(row, {
      products: [{ name: 'iPhone 18 Pro Max 256GB 银色', quantity: 1 }],
    });
    await service.reconcile();
    expect((await row.reload()).orderId).toBeNull();
    await service.changeOrder(
      'link',
      row.id,
      {
        expectedVersion: row.version,
        orderNumber: order.orderNumber,
        reason: '备注允许银色，人工核对',
      },
      actor.id
    );
    expect((await row.reload()).status).toBe('succeeded');
    await service.changeOrder(
      'link',
      row.id,
      { expectedVersion: row.version, orderNumber: null, reason: '人工纠错' },
      actor.id
    );
    await order.update({ products: [{ name: 'iPhone 18 Pro Max 256GB 酒红色', quantity: 1 }] });
    await service.reconcile();
    expect((await row.reload()).orderId).toBeNull();
    await order.update({ recipientName: '李四' });
    await expect(
      service.changeOrder(
        'link',
        row.id,
        { expectedVersion: row.version, orderNumber: order.orderNumber, reason: '错误客户' },
        actor.id
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  test('粘贴导入幂等、冲突整批回滚、已有候选纳入保留状态备注', async () => {
    await service.changeAccounts(
      'import',
      { text: 'a@example.com synthetic-a\nb@example.com----synthetic-b' },
      actor.id
    );
    await service.changeAccounts('import', { text: 'a@example.com synthetic-a' }, actor.id);
    expect(await m.AppleId.count()).toBe(2);
    await expect(
      service.changeAccounts(
        'import',
        { text: 'c@example.com new\na@example.com different' },
        actor.id
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await m.AppleId.count()).toBe(2);
    const [existing] = await pool(1, { isProxyPool: false, status: '使用中', notes: '代抢历史' });
    await service.changeAccounts('adopt', { ids: [existing.id] }, actor.id);
    expect((await existing.reload()).toJSON()).toMatchObject({
      isProxyPool: true,
      status: '使用中',
      notes: '代抢历史',
    });
    await service.changeAccounts(
      'update',
      { status: '未使用', notes: '已核对', expectedUpdatedAt: existing.updatedAt.toISOString() },
      actor.id,
      existing.id
    );
    await expect(
      service.changeAccounts(
        'update',
        { status: '异常', notes: '', expectedUpdatedAt: '2000-01-01' },
        actor.id,
        existing.id
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  test('独立接口鉴权；代抢只读可读官方摘要，不能复制或操作池', async () => {
    await pool();
    const row = await create();
    const order = await official(row, {
      applePassword: 'secret-official',
      orderUrl: 'https://example.com/private',
    });
    await service.reconcile();
    expect((await fetch(base)).status).toBe(403);
    const headers = {
      'x-test-permissions': 'proxy_orders.read',
      'Content-Type': 'application/json',
    };
    const response = await fetch(`${base}/${row.id}`, { headers });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(text).toContain(order.orderNumber);
    expect(text).not.toContain('secret-official');
    expect(text).not.toContain('private');
    expect(text).not.toContain('Synthetic-Pass');
    for (const path of ['copy', 'parse', 'accounts/import'])
      expect((await fetch(`${base}/${path}`, { method: 'POST', headers, body: '{}' })).status).toBe(
        403
      );
    expect((await fetch(`${base}/accounts`, { headers })).status).toBe(403);
    for (const action of ['status', 'accounts', 'release', 'link'])
      expect(
        (await fetch(`${base}/${row.id}/${action}`, { method: 'POST', headers, body: '{}' })).status
      ).toBe(403);
  });
  test('分页筛选、客户查询、编辑冲突和已结束只改备注', async () => {
    const row = await create({ platformOrderNumber: 'abc' });
    expect((await service.listOrders({ keyword: '张三' })).count).toBe(1);
    expect(
      (await service.listOrders({ keyword: 'abc', status: 'pending', limit: 1 })).rows
    ).toHaveLength(1);
    await service.saveOrder(
      row.id,
      { ...payload({ notes: '可选银色' }), expectedVersion: row.version },
      actor.id
    );
    await expect(
      service.saveOrder(row.id, { ...payload(), expectedVersion: 1 }, actor.id)
    ).rejects.toMatchObject({ statusCode: 409 });
    await row.reload();
    await service.changeOrder(
      'status',
      row.id,
      { expectedVersion: row.version, status: 'cancelled' },
      actor.id
    );
    await row.reload();
    await expect(
      service.saveOrder(row.id, { ...payload(), expectedVersion: row.version }, actor.id)
    ).rejects.toMatchObject({ statusCode: 409 });
    await service.saveOrder(row.id, { notes: '客户取消', expectedVersion: row.version }, actor.id);
    expect((await row.reload()).notes).toBe('客户取消');
    await expect(
      require('../migrations/20260928000002-add-proxy-orders').down(m.sequelize.getQueryInterface())
    ).rejects.toThrow('已有代抢');
  });
});
