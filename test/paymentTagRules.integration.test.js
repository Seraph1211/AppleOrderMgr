const RUN_INTEGRATION = process.env.RUN_TAG_RULE_INTEGRATION === 'true';
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

describeIntegration('AOS TAG 自动分配隔离库验收', () => {
  let m;
  let service;
  let dispatch;
  let admin;
  let people;
  let serial = 0;
  let server;
  let baseUrl;
  const ruleInput = (tags, ids, extra = {}) => ({
    name: '合成规则',
    enabled: true,
    recipientTags: tags,
    assigneeUserIds: ids,
    ...extra,
  });
  async function makeTask(tag, extra = {}) {
    const orderNumber = `W${String(++serial).padStart(10, '0')}`;
    const order = await m.Order.create({
      orderNumber,
      ingestionSource: 'aos',
      sourceRecipientTag: tag,
      tag: '档案不匹配',
      status: 'payment_due',
      paymentStatus: 'unpaid',
      products: [{ name: '合成手机', model: 'TEST-PHONE', quantity: 1 }],
      orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/synthetic`,
      orderDate: new Date(),
      officialOrderCreatedAt: new Date(),
      ...extra,
    });
    return await m.PaymentTask.create({
      orderId: order.id,
      processingStatus: 'pending',
      deadlineAt: new Date(Date.now() + 1800000),
      deadlineSource: 'official',
      paymentLinkSource: 'order_url',
    });
  }
  async function createRule(tags, ids, extra) {
    return await service.saveRule(null, ruleInput(tags, ids, extra), admin.id);
  }
  async function request(method, path, body, actor = 'admin') {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Test-Actor': actor },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  beforeAll(async () => {
    if (
      !/^apple_order_mgr_.+_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    )
      throw new Error('只能使用隔离测试库');
    m = require('../src/models');
    service = require('../src/services/paymentTagRuleService');
    dispatch = require('../src/services/paymentDispatchService');
    await m.sequelize.authenticate();
    const express = require('express');
    const app = express();
    app.use(express.json());
    // 只注入合成身份，权限检查使用正式路由中间件。
    app.use((req, _res, next) => {
      req.user =
        req.get('X-Test-Actor') === 'admin'
          ? {
            id: admin.id,
            role: 'admin',
            permissions: ['payment_dispatch.configure', 'payment_dispatch.read'],
          }
          : { id: people[0].id, role: 'operator', permissions: ['payment_tasks.read_own'] };
      next();
    });
    app.use('/rules', require('../src/routes/paymentDispatch'));
    app.use((error, _req, res, _next) =>
      res
        .status(error.statusCode || 500)
        .json({ error: { code: error.code, message: error.message } })
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    await m.sequelize.query(
      'TRUNCATE users, orders, payment_dispatch_settings, payment_tag_rules RESTART IDENTITY CASCADE'
    );
    admin = await m.User.create({
      username: 'tag_admin',
      password: 'synthetic-only',
      role: 'admin',
      status: 'active',
    });
    people = await m.User.bulkCreate(
      [1, 2, 3].map(id => ({
        username: `tag_staff_${id}`,
        password: 'synthetic-only',
        role: 'operator',
        status: 'active',
      }))
    );
    const permissions = require('../src/constants/permissionCatalog').PAYMENT_EXECUTION_PERMISSIONS;
    await m.UserPermission.bulkCreate(
      people.flatMap(person =>
        permissions.map(permissionCode => ({ userId: person.id, permissionCode }))
      )
    );
    await m.PaymentStaffSetting.bulkCreate(
      people.map(person => ({ userId: person.id, autoAssignEnabled: true, maxActiveTasks: 10 }))
    );
    await m.PaymentDispatchSetting.create({
      id: 1,
      enabled: true,
      mode: 'auto',
      scopeStartedAt: new Date(Date.now() - 60000),
    });
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (m) await m.sequelize.close();
  });

  test('TAG 专属账号不接普通订单，释放容量后仅补匹配单', async () => {
    await createRule(['A'], [people[0].id]);
    await m.PaymentStaffSetting.update({ maxActiveTasks: 1 }, { where: { userId: people[0].id } });
    const normal = await makeTask('OTHER');
    const first = await makeTask('A');
    const second = await makeTask('A');
    expect((await dispatch.runDispatchScan()).assigned).toBe(2);
    expect((await normal.reload()).assigneeUserId).not.toBe(people[0].id);
    expect((await first.reload()).assigneeUserId).toBe(people[0].id);
    expect((await second.reload()).assigneeUserId).toBeNull();
    await first.update({ processingStatus: 'completed' });
    expect((await dispatch.runDispatchScan()).assigned).toBe(1);
    expect((await second.reload()).assigneeUserId).toBe(people[0].id);
  });
  test('多条启用绑定全部解除才恢复普通分配，既有非 TAG 负责人保留', async () => {
    const old = await makeTask('OTHER');
    await old.update({ assigneeUserId: people[0].id });
    const a = await createRule(['A'], [people[0].id]);
    const b = await createRule(['B'], [people[0].id]);
    await m.PaymentStaffSetting.update(
      { autoAssignEnabled: false },
      {
        where: { userId: [people[1].id, people[2].id] },
      }
    );
    const normal = await makeTask('OTHER');
    expect((await dispatch.runDispatchScan()).assigned).toBe(0);
    expect(
      (await dispatch.listDispatchTasks({ assignee: 'unassigned' })).items[0].autoAssignment
        .reasonCode
    ).toBe('NO_ELIGIBLE_STAFF');
    await service.saveRule(a.id, { ...a.toJSON(), enabled: false, expectedVersion: 0 }, admin.id);
    expect((await dispatch.runDispatchScan()).assigned).toBe(0);
    expect(
      (await dispatch.getDispatchOverview()).staff.find(p => p.id === people[0].id)
    ).toMatchObject({ assignmentMode: 'tag_only', tagRules: [{ id: b.id, name: b.name }] });
    await service.saveRule(b.id, { expectedVersion: 0 }, admin.id, true);
    expect((await dispatch.runDispatchScan()).assigned).toBe(1);
    expect((await normal.reload()).assigneeUserId).toBe(people[0].id);
    expect((await old.reload()).assigneeUserId).toBe(people[0].id);
  });
  test('管理员复制任意任务，普通账号拒绝，访问审计不保存链接', async () => {
    const task = await makeTask('A');
    await task.update({ processingStatus: 'completed', assigneeUserId: people[0].id });
    const result = await request('GET', `/rules/tasks/${task.id}/payment-link`);
    expect(result.status).toBe(200);
    expect(result.body.data.paymentUrl).toContain('/synthetic');
    expect(
      (await request('GET', `/rules/tasks/${task.id}/payment-link`, null, 'staff')).status
    ).toBe(403);
    expect((await request('GET', '/rules/tasks/abc/payment-link')).status).toBe(400);
    expect((await request('GET', '/rules/tasks/999999/payment-link')).status).toBe(404);
    const event = await m.PaymentTaskEvent.findOne({
      where: { eventType: 'payment_link_accessed' },
    });
    expect(event.actorUserId).toBe(admin.id);
    expect(JSON.stringify(event.details)).not.toContain('/synthetic');
    expect((await task.reload()).processingStatus).toBe('completed');
    await m.Order.update({ orderUrl: null }, { where: { id: task.orderId } });
    expect((await request('GET', `/rules/tasks/${task.id}/payment-link`)).status).toBe(404);
  });
  test('首次刷新 Migration down/up 保留首次队列，后续自动队列不改成首次', async () => {
    const migration = require('../migrations/20260913000001-add-initial-refresh-trigger');
    const task = await makeTask('A');
    const another = await makeTask('B');
    const initial = await m.OrderRefreshJob.create({
      orderId: task.orderId,
      trigger: 'initial',
      scheduledAt: new Date(),
    });
    await m.OrderRefreshJob.create({
      orderId: another.orderId,
      trigger: 'auto',
      status: 'failed',
      scheduledAt: new Date(),
    });
    const repeated = await m.OrderRefreshJob.create({
      orderId: another.orderId,
      trigger: 'auto',
      scheduledAt: new Date(),
    });
    await migration.down(m.sequelize.getQueryInterface());
    expect((await initial.reload()).trigger).toBe('auto');
    await migration.up(m.sequelize.getQueryInterface());
    expect((await initial.reload()).trigger).toBe('initial');
    expect((await repeated.reload()).trigger).toBe('auto');
    await expect(
      m.OrderRefreshJob.create({
        orderId: task.orderId,
        trigger: 'bogus',
        scheduledAt: new Date(),
      })
    ).rejects.toThrow();
  });

  test('两页官网状态多选在分页前过滤，与 TAG 条件交集且本人范围隔离', async () => {
    const tasks = [];
    for (let i = 0; i < 9; i++) {
      const task = await makeTask(i < 6 ? 'FILTER-A' : 'FILTER-B', {
        status: ['payment_due', 'processing', 'cancelled'][i % 3],
      });
      await task.update({ assigneeUserId: i % 2 ? people[1].id : people[0].id });
      tasks.push(task);
    }
    const query = { officialOrderStatuses: '["payment_due","processing"]', limit: 2 };
    const first = await dispatch.listDispatchTasks(query);
    const second = await dispatch.listDispatchTasks({ ...query, page: 2 });
    expect(first.pagination.total).toBe(6);
    expect(second.pagination.total).toBe(6);
    expect(new Set([...first.items, ...second.items].map(t => t.id)).size).toBe(4);
    expect(
      [...first.items, ...second.items].every(t =>
        ['payment_due', 'processing'].includes(t.officialOrderStatus)
      )
    ).toBe(true);
    expect(
      (await dispatch.listDispatchTasks({ ...query, recipientTags: '["FILTER-A"]' })).pagination
        .total
    ).toBe(4);
    const own = await require('../src/services/paymentTaskService').listOwnTasks(
      people[0].id,
      query
    );
    expect(own.pagination.total).toBe(3);
    expect(own.items.every(t => t.assignee.id === people[0].id)).toBe(true);
    expect(
      (await dispatch.listDispatchTasks({ officialOrderStatus: 'cancelled' })).pagination.total
    ).toBe(3);
    expect(
      (await dispatch.listDispatchTasks({ officialOrderStatuses: '[]' })).pagination.total
    ).toBe(9);
    expect(
      (await dispatch.listDispatchTasks({ officialOrderStatuses: '["shipped"]' })).pagination.total
    ).toBe(0);
    const invalid = await request('GET', '/rules/tasks?officialOrderStatuses=bad');
    expect(invalid.status).toBe(400);
    await expect(
      require('../src/services/paymentTaskService').listOwnTasks(people[0].id, {
        officialOrderStatuses: '["bad"]',
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('四个列表按下单日期过滤，午夜边界和本人范围一致，渠道统计同步', async () => {
    const dates = [
      '2026-09-12T15:59:59.999Z',
      '2026-09-12T16:00:00.000Z',
      '2026-09-13T15:59:59.999Z',
      '2026-09-13T16:00:00.000Z',
      null,
    ];
    for (let i = 0; i < dates.length; i++) {
      const task = await makeTask('DATE', { orderDate: dates[i], tag: 'DATE' });
      await task.update({ assigneeUserId: i === 2 ? people[1].id : people[0].id });
    }
    const query = { dateFrom: '2026-09-13', dateTo: '2026-09-13', limit: 1 };
    const dispatchPage = await dispatch.listDispatchTasks(query);
    expect(dispatchPage.pagination.total).toBe(2);
    expect(dispatchPage.items).toHaveLength(1);
    expect((await dispatch.listDispatchTasks({ ...query, page: 2 })).items[0].id).not.toBe(
      dispatchPage.items[0].id
    );
    const own = await require('../src/services/paymentTaskService').listOwnTasks(
      people[0].id,
      query
    );
    expect(own.pagination.total).toBe(1);
    const controller = require('../src/controllers/orderController');
    const { where } = controller.buildListFilters(query);
    expect(await m.Order.count({ where })).toBe(2);
    expect(
      await m.Order.count({
        where: controller.buildListFilters({
          'date_from': '2026-09-13',
          'date_to': '2026-09-13',
        }).where,
      })
    ).toBe(2);
    const channel = require('../src/controllers/channelController');
    const next = jest.fn();
    const res = { json: jest.fn() };
    await channel.getChannelOrders({ params: { tag: 'DATE' }, query }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data.total).toBe(2);
    res.json.mockClear();
    await channel.getChannelStats({ params: { tag: 'DATE' }, query }, res, next);
    expect(res.json.mock.calls[0][0].data.totalOrders).toBe(2);
    expect(
      (await dispatch.listDispatchTasks({ ...query, dateFrom: '2026-09-20', dateTo: '' }))
        .pagination.total
    ).toBe(0);
  });
  test('多 TAG 多账号仅在指定集合内按比例分配并记录规则快照', async () => {
    const rule = await createRule(
      ['A', 'B'],
      people.slice(0, 2).map(person => person.id)
    );
    await m.PaymentStaffSetting.update({ maxActiveTasks: 20 }, { where: { userId: people[1].id } });
    const tasks = [];
    for (let i = 0; i < 6; i++) tasks.push(await makeTask(i % 2 ? 'A' : 'B'));
    expect((await dispatch.runDispatchScan()).assigned).toBe(6);
    const all = await m.PaymentTask.findAll();
    expect(all.filter(row => row.assigneeUserId === people[0].id)).toHaveLength(2);
    expect(all.filter(row => row.assigneeUserId === people[1].id)).toHaveLength(4);
    const events = await m.PaymentTaskEvent.findAll({ where: { eventType: 'auto_assigned' } });
    expect(events).toHaveLength(6);
    expect(events[0].details.tagRule).toMatchObject({
      id: rule.id,
      version: 0,
      assigneeUserIds: rule.assigneeUserIds,
    });
  });
  test('指定账号满载等待，不回退；跨扫描批次仍分配其他规则和默认订单', async () => {
    await createRule(['A'], [people[0].id]);
    await createRule(['B'], [people[1].id]);
    await m.PaymentStaffSetting.update({ maxActiveTasks: 0 }, { where: { userId: people[0].id } });
    const blocked = [];
    for (let i = 0; i < 5; i++) blocked.push(await makeTask('A'));
    const matched = await makeTask('B');
    const fallback = await makeTask('OTHER');
    expect((await dispatch.runDispatchScan(2)).assigned).toBe(2);
    expect((await matched.reload()).assigneeUserId).toBe(people[1].id);
    expect((await fallback.reload()).assigneeUserId).toBe(people[2].id);
    expect((await blocked[0].reload()).assigneeUserId).toBeNull();
    const page = await dispatch.listDispatchTasks({ assignee: 'unassigned' });
    expect(page.items).toHaveLength(5);
    expect(page.items[0].autoAssignment.reasonCode).toBe('RULE_CAPACITY_FULL');
    await m.PaymentStaffSetting.update({ maxActiveTasks: 10 }, { where: { userId: people[0].id } });
    expect((await dispatch.runDispatchScan(2)).assigned).toBe(5);
    expect((await blocked[4].reload()).assigneeUserId).toBe(people[0].id);
  });
  test('完整匹配、来源限定、空 TAG 与 AOS 兼容回退', async () => {
    await createRule(['A'], [people[0].id]);
    await m.PaymentStaffSetting.update(
      { autoAssignEnabled: false },
      { where: { userId: people[0].id } }
    );
    const exact = await makeTask('A');
    const old = await makeTask(null, { tag: 'A' });
    const prefix = await makeTask('A-more');
    const email = await makeTask('A', { ingestionSource: 'email', tag: 'A' });
    const empty = await makeTask(null, { tag: null });
    const lower = await makeTask('a');
    expect((await dispatch.runDispatchScan()).assigned).toBe(4);
    expect((await exact.reload()).assigneeUserId).toBeNull();
    expect((await old.reload()).assigneeUserId).toBeNull();
    for (const task of [prefix, email, empty, lower])
      expect((await task.reload()).assigneeUserId).not.toBeNull();
    const options = await service.listRules();
    expect(options.tagOptions).toEqual(['A', 'A-more', 'a']);
  });
  test.each(['locked', 'permission', 'auto', 'deleted'])(
    '目标账号 %s 时等待，恢复后仍只分给规则账号',
    async condition => {
      await createRule(['A'], [people[0].id]);
      const task = await makeTask('A');
      if (condition === 'locked') await people[0].update({ status: 'locked' });
      if (condition === 'permission')
        await m.UserPermission.destroy({ where: { userId: people[0].id } });
      if (condition === 'auto')
        await m.PaymentStaffSetting.update(
          { autoAssignEnabled: false },
          { where: { userId: people[0].id } }
        );
      if (condition === 'deleted') await people[0].destroy();
      expect((await dispatch.runDispatchScan()).assigned).toBe(0);
      expect((await dispatch.listDispatchTasks()).items[0].autoAssignment.reasonCode).toBe(
        'RULE_NO_ELIGIBLE_STAFF'
      );
      expect((await task.reload()).assigneeUserId).toBeNull();
    }
  );
  test('规则更新只影响未分配任务，允许管理员手动转派到规则外', async () => {
    const rule = await createRule(['A'], [people[0].id]);
    const assigned = await makeTask('A');
    await dispatch.runDispatchScan();
    const pending = await makeTask('A');
    await service.saveRule(
      rule.id,
      { ...rule.toJSON(), assigneeUserIds: [people[1].id], expectedVersion: rule.version },
      admin.id
    );
    await dispatch.runDispatchScan();
    expect((await assigned.reload()).assigneeUserId).toBe(people[0].id);
    expect((await pending.reload()).assigneeUserId).toBe(people[1].id);
    await dispatch.assignTask(
      Number(assigned.id),
      {
        assigneeUserId: people[2].id,
        expectedVersion: assigned.version,
        handoffConfirmed: true,
        idempotencyKey: 'tag-manual-transfer',
      },
      admin.id
    );
    expect((await assigned.reload()).assigneeUserId).toBe(people[2].id);
    expect(
      (await dispatch.listDispatchTasks()).items.every(row => row.autoAssignment === null)
    ).toBe(true);
  });
  test('停用和删除规则恢复默认算法，审计保留完整前后快照', async () => {
    let rule = await createRule(['A'], [people[0].id]);
    await m.PaymentStaffSetting.update(
      { autoAssignEnabled: false },
      { where: { userId: people[0].id } }
    );
    const one = await makeTask('A');
    rule = await service.saveRule(
      rule.id,
      { ...rule.toJSON(), enabled: false, expectedVersion: 0 },
      admin.id
    );
    expect((await dispatch.runDispatchScan()).assigned).toBe(1);
    expect((await one.reload()).assigneeUserId).not.toBe(people[0].id);
    rule = await service.saveRule(
      rule.id,
      { ...rule.toJSON(), enabled: true, expectedVersion: rule.version },
      admin.id
    );
    const two = await makeTask('A');
    await service.saveRule(rule.id, { expectedVersion: rule.version }, admin.id, true);
    expect((await dispatch.runDispatchScan()).assigned).toBe(1);
    expect((await two.reload()).assigneeUserId).not.toBe(people[0].id);
    const event = await m.PaymentDispatchEvent.findOne({
      where: { eventType: 'tag_rule_deleted' },
    });
    expect(event.details.before.recipientTags).toEqual(['A']);
    expect(event.details.after).toBeNull();
  });
  test('重复启用 TAG、陈旧版本、非法账号与并发写入均不产生部分保存', async () => {
    const rule = await createRule(['A'], [people[0].id]);
    await expect(createRule(['A'], [people[1].id])).rejects.toMatchObject({
      code: 'TAG_RULE_CONFLICT',
    });
    const disabled = await createRule(['A'], [people[1].id], { enabled: false });
    await expect(
      service.saveRule(
        disabled.id,
        { ...disabled.toJSON(), enabled: true, expectedVersion: 0 },
        admin.id
      )
    ).rejects.toMatchObject({ code: 'TAG_RULE_CONFLICT' });
    await expect(
      service.saveRule(rule.id, { expectedVersion: 2 }, admin.id, true)
    ).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    await expect(createRule(['C'], [999999])).rejects.toMatchObject({ statusCode: 400 });
    const results = await Promise.allSettled(
      [1, 2].map(i =>
        service.saveRule(
          rule.id,
          { ...rule.toJSON(), name: `并发${i}`, expectedVersion: 0 },
          admin.id
        )
      )
    );
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason.code).toBe(
      'CONCURRENT_MODIFICATION'
    );
    expect(await m.PaymentTagRule.count()).toBe(2);
  });
  test('保留失效账号引用但拒绝新增失效账号，避免规则意外回退', async () => {
    const rule = await createRule(['A'], [people[0].id]);
    await people[0].destroy();
    const updated = await service.saveRule(
      rule.id,
      { ...rule.toJSON(), name: '保留失效账号', expectedVersion: 0 },
      admin.id
    );
    expect(updated.assigneeUserIds).toEqual([people[0].id]);
    await expect(createRule(['B'], [people[0].id])).rejects.toMatchObject({ statusCode: 400 });
  });
  test('模式及付款资格不被 TAG 绕过，多实例扫描无重复分配', async () => {
    await createRule(['A'], [people[0].id]);
    const due = await makeTask('A');
    const paid = await makeTask('A', { paymentStatus: 'paid' });
    const expired = await makeTask('A', { officialOrderCreatedAt: new Date(Date.now() - 3600000) });
    const unknown = await makeTask('A', { officialOrderCreatedAt: null });
    await m.PaymentDispatchSetting.update({ mode: 'manual' }, { where: { id: 1 } });
    expect((await dispatch.runDispatchScan()).assigned).toBe(0);
    await m.PaymentDispatchSetting.update({ enabled: false }, { where: { id: 1 } });
    expect((await dispatch.runDispatchScan()).skipped).toBe('disabled');
    await m.PaymentDispatchSetting.update({ enabled: true, mode: 'auto' }, { where: { id: 1 } });
    const results = await Promise.all([dispatch.runDispatchScan(), dispatch.runDispatchScan()]);
    expect(results.reduce((sum, result) => sum + result.assigned, 0)).toBe(1);
    expect((await due.reload()).assigneeUserId).toBe(people[0].id);
    for (const task of [paid, expired, unknown])
      expect((await task.reload()).assigneeUserId).toBeNull();
  });
  test('真实路由 CRUD 状态码、版本和普通账号权限拒绝', async () => {
    const created = await request('POST', '/rules/tag-rules', ruleInput(['API'], [people[0].id]));
    expect(created.status).toBe(201);
    const rule = created.body.data;
    expect((await request('GET', '/rules/tag-rules')).body.data.items).toHaveLength(1);
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      expect(
        (
          await request(
            method,
            `/rules/tag-rules${['PUT', 'DELETE'].includes(method) ? `/${rule.id}` : ''}`,
            method === 'GET' ? null : ruleInput(['BAD'], [people[0].id]),
            'staff'
          )
        ).status
      ).toBe(403);
    }
    expect(
      (
        await request('PUT', `/rules/tag-rules/${rule.id}`, {
          ...rule,
          name: 'API 修改',
          expectedVersion: 0,
        })
      ).status
    ).toBe(200);
    expect(
      (await request('DELETE', `/rules/tag-rules/${rule.id}`, { expectedVersion: 0 })).status
    ).toBe(409);
    expect(
      (await request('DELETE', `/rules/tag-rules/${rule.id}`, { expectedVersion: 1 })).status
    ).toBe(200);
    expect(
      (await request('DELETE', `/rules/tag-rules/${rule.id}`, { expectedVersion: 1 })).status
    ).toBe(404);
  });
});
