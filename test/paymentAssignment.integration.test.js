const enabled = process.env.RUN_ASSIGNMENT_INTEGRATION === 'true';
(enabled ? describe : describe.skip)('来源时间付款分配隔离库', () => {
  let m;
  let service;
  let admin;
  let serial = 0;
  const request = (tasks, extra = {}) => ({
    tasks: tasks.map(t => ({ id: Number(t.id), expectedVersion: t.version })),
    assigneeUserId: admin.id,
    idempotencyKey: `assignment-${++serial}`,
    ...extra,
  });
  async function makeTask(patch = {}, taskPatch = {}) {
    const orderNumber = `W${String(++serial).padStart(10, '0')}`;
    const order = await m.Order.create({
      orderNumber,
      status: 'pending',
      orderDate: new Date(),
      orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/synthetic`,
      products: [{ name: '合成商品', model: 'TEST', quantity: 1 }],
      ...patch,
    });
    return m.PaymentTask.create({ orderId: order.id, processingStatus: 'pending', ...taskPatch });
  }
  beforeAll(async () => {
    if (
      !/^apple_order_mgr_assignment_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    )
      throw new Error('只允许独立合成测试库');
    m = require('../src/models');
    service = require('../src/services/paymentDispatchService');
    await m.sequelize.authenticate();
  });
  beforeEach(async () => {
    await m.sequelize.query(
      'TRUNCATE users, orders, payment_dispatch_settings RESTART IDENTITY CASCADE'
    );
    admin = await m.User.create({
      username: 'synthetic_admin',
      password: 'synthetic-password',
      role: 'admin',
      status: 'active',
    });
    await m.PaymentStaffSetting.create({
      userId: admin.id,
      maxActiveTasks: 5,
      autoAssignEnabled: false,
    });
    await m.PaymentDispatchSetting.create({
      id: 1,
      enabled: true,
      mode: 'auto',
      scopeStartedAt: new Date(Date.now() - 60000),
    });
  });
  afterAll(async () => {
    if (m) await m.sequelize.close();
  });

  test('预检只读；无官网时间、身份异常、状态未知均可手动分配；重试幂等', async () => {
    const task = await makeTask({
      status: 'unknown',
      officialStatusNeedsReview: true,
      validationIssues: [{ type: 'order_identity' }],
    });
    const input = request([task]);
    const preview = await service.previewAssignment(input);
    expect(preview.eligibleCount).toBe(1);
    expect(preview.items[0].warnings).toHaveLength(2);
    expect(await m.PaymentTaskEvent.count()).toBe(0);
    expect((await task.reload()).assigneeUserId).toBeNull();
    await service.assignTasks(input, admin.id);
    await service.assignTasks(input, admin.id);
    expect((await task.reload()).deadlineSource).toBe('source_order');
    expect(await m.PaymentTaskEvent.count({ where: { eventType: 'assigned' } })).toBe(1);
  });

  test('自动从来源时间选取空或过时缓存任务；跨页跳过异常链接和过期', async () => {
    await m.PaymentStaffSetting.update(
      { autoAssignEnabled: true },
      { where: { userId: admin.id } }
    );
    await makeTask({ orderUrl: 'https://invalid.example' });
    const task = await makeTask(
      { officialStatusNeedsReview: true, validationIssues: [{ type: 'order_identity' }] },
      { deadlineAt: new Date(0), deadlineSource: 'official' }
    );
    const expired = await makeTask({ orderDate: new Date(Date.now() - 3600000) });
    const result = await service.runDispatchScan(1);
    expect(result.assigned).toBe(1);
    expect((await task.reload()).assigneeUserId).toBe(admin.id);
    expect((await expired.reload()).assigneeUserId).toBeNull();
  });

  test('整批失败无部分提交，失败原因在事务外落库；仅选择合格子集可成功', async () => {
    const good = await makeTask();
    const paid = await makeTask({ paymentStatus: 'paid' });
    const missing = await makeTask({ orderDate: null, officialOrderCreatedAt: new Date() });
    const input = request([good, paid, missing]);
    const preview = await service.previewAssignment(input);
    expect(preview.eligibleCount).toBe(1);
    expect(preview.items.filter(i => !i.eligible).map(i => i.code)).toEqual([
      'PAYMENT_NOT_ELIGIBLE',
      'UNKNOWN_DEADLINE',
    ]);
    await expect(
      service.assignTasks(input, admin.id, { requestId: 'synthetic-request' })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await m.PaymentTask.count({ where: { assigneeUserId: admin.id } })).toBe(0);
    const audit = await m.PaymentDispatchEvent.findOne({
      where: { eventType: 'assignment_failed' },
    });
    expect(audit.details).toMatchObject({
      requestId: 'synthetic-request',
      assigneeUserId: admin.id,
      taskIds: input.tasks.map(t => t.id),
    });
    expect(JSON.stringify(audit.details)).not.toContain('https:');
    await service.assignTasks(request([good]), admin.id);
    expect((await good.reload()).assigneeUserId).toBe(admin.id);
    expect((await paid.reload()).assigneeUserId).toBeNull();
  });

  test('容量逐条预检，预检后容量变化正式提交仍拒绝；同负责人不重复占容量', async () => {
    await m.PaymentStaffSetting.update({ maxActiveTasks: 1 }, { where: { userId: admin.id } });
    const first = await makeTask();
    const second = await makeTask();
    const preview = await service.previewAssignment(request([first, second]));
    expect(preview.eligibleCount).toBe(1);
    expect(preview.items[1].code).toBe('CAPACITY_EXCEEDED');
    const input = request([first]);
    expect((await service.previewAssignment(input)).eligibleCount).toBe(1);
    await service.assignTasks(request([second]), admin.id);
    await expect(service.assignTasks(input, admin.id)).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
    });
    expect((await first.reload()).assigneeUserId).toBeNull();
    await second.reload();
    expect((await service.previewAssignment(request([second]))).eligibleCount).toBe(1);
    await service.assignTasks(request([second]), admin.id);
  });

  test('过期仅手动允许；版本、完成、链接和接收人权限仍拦截', async () => {
    const expired = await makeTask({
      orderDate: new Date(Date.now() - 3600000),
      status: 'payment_expired',
    });
    expect((await service.previewAssignment(request([expired]))).items[0]).toMatchObject({
      eligible: true,
      expired: true,
    });
    await service.assignTasks(request([expired]), admin.id);
    const completed = await makeTask({}, { processingStatus: 'completed' });
    const badLink = await makeTask({
      orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/Wother/synthetic',
    });
    const stale = await makeTask({}, { version: 2 });
    const input = request([completed, badLink, stale]);
    input.tasks[2].expectedVersion = 1;
    expect((await service.previewAssignment(input)).items.map(i => i.code)).toEqual([
      'INVALID_STATE',
      'PAYMENT_LINK_INVALID',
      'CONCURRENT_MODIFICATION',
    ]);
    const noPermission = await m.User.create({
      username: 'synthetic_staff',
      password: 'synthetic-password',
      role: 'operator',
      status: 'active',
    });
    const normal = await makeTask();
    expect(
      (await service.previewAssignment(request([normal], { assigneeUserId: noPermission.id })))
        .blockedCount
    ).toBe(1);
  });

  test('预检 HTTP 保留管理员权限隔离，正式失败响应关联审计请求', async () => {
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.requestId = 'synthetic-http-request';
      req.user = {
        id: admin.id,
        role: req.get('X-Role') || 'admin',
        permissions: ['payment_dispatch.assign'],
      };
      next();
    });
    app.use('/api/payment-dispatch', require('../src/routes/paymentDispatch'));
    app.use(require('../src/middleware/errorHandler'));
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}/api/payment-dispatch/tasks`;
      const task = await makeTask({ paymentStatus: 'paid' });
      const input = request([task]);
      const send = (path, method, role) =>
        fetch(base + path, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Role': role },
          body: JSON.stringify(input),
        });
      expect((await send('/assignment-preview', 'POST', 'operator')).status).toBe(403);
      const preview = await send('/assignment-preview', 'POST', 'admin');
      expect(preview.status).toBe(200);
      expect((await preview.json()).data.blockedCount).toBe(1);
      const response = await send('/assignee', 'PUT', 'admin');
      expect(response.status).toBe(409);
      expect((await response.json()).error.details.requestId).toBe('synthetic-http-request');
      const audit = await m.PaymentDispatchEvent.findOne({
        where: { eventType: 'assignment_failed' },
      });
      expect(audit.details.requestId).toBe('synthetic-http-request');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('来源约束迁移 down/up 保留归属并清理新缓存', async () => {
    const task = await makeTask();
    await service.assignTasks(request([task]), admin.id);
    const migration = require('../migrations/20260920000002-payment-source-deadline');
    await migration.down(m.sequelize.getQueryInterface());
    expect((await task.reload()).deadlineAt).toBeNull();
    expect(task.assigneeUserId).toBe(admin.id);
    await migration.up(m.sequelize.getQueryInterface());
    await service.assignTasks(request([task], { assigneeUserId: admin.id }), admin.id);
  });
});
