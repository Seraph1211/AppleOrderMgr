const RUN_INTEGRATION = process.env.RUN_PAYMENT_INTEGRATION === 'true';
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

describeIntegration('权限与付款任务隔离库集成验收', () => {
  let models;
  let permissionService;
  let dispatchService;
  let paymentTaskService;
  let payerService;
  let admin;
  let staffOne;
  let staffTwo;

  beforeAll(async () => {
    if (!/^apple_order_mgr_.+_test_\d+$/.test(process.env.DB_NAME || '')) {
      throw new Error('只允许在明确的隔离测试库执行');
    }
    models = require('../src/models');
    permissionService = require('../src/services/permissionService');
    dispatchService = require('../src/services/paymentDispatchService');
    paymentTaskService = require('../src/services/paymentTaskService');
    payerService = require('../src/services/payerService');
    await models.sequelize.authenticate();
    await models.sequelize.query(
      `TRUNCATE TABLE payment_dispatch_events, payment_task_events, order_payer_events,
       payment_tasks, payment_staff_settings, user_permission_events,
       user_permissions, order_refresh_jobs, order_refresh_schedules, email_logs,
       crawl_logs, orders, recipients, apple_ids, users RESTART IDENTITY CASCADE`
    );

    [admin, staffOne, staffTwo] = await Promise.all([
      models.User.create({
        username: 'integration_admin',
        password: 'synthetic-password',
        role: 'admin',
        status: 'active',
        forcePasswordChange: false,
      }),
      models.User.create({
        username: 'integration_staff_1',
        password: 'synthetic-password',
        role: 'operator',
        status: 'active',
        forcePasswordChange: false,
      }),
      models.User.create({
        username: 'integration_staff_2',
        password: 'synthetic-password',
        role: 'operator',
        status: 'active',
        forcePasswordChange: false,
      }),
    ]);
    const grants = [staffOne.id, staffTwo.id].flatMap(userId =>
      require('../src/constants/permissionCatalog').PAYMENT_EXECUTION_PERMISSIONS.map(
        permissionCode => ({ userId, permissionCode, grantedBy: admin.id })
      )
    );
    await models.UserPermission.bulkCreate(grants);
    await models.PaymentStaffSetting.bulkCreate([
      { userId: staffOne.id, autoAssignEnabled: true, maxActiveTasks: 100 },
      { userId: staffTwo.id, autoAssignEnabled: true, maxActiveTasks: 100 },
    ]);
    await models.PaymentDispatchSetting.create({
      id: 1,
      enabled: true,
      mode: 'auto',
      scopeStartedAt: new Date(Date.now() - 60_000),
    });
  });

  afterAll(async () => {
    if (models) await models.sequelize.close();
  });

  test('百余单集中到达时按负载比分配且不超容量', async () => {
    const now = Date.now();
    const orders = await models.Order.bulkCreate(
      Array.from({ length: 150 }, (_, index) => ({
        orderNumber: `W${String(index + 1).padStart(10, '0')}`,
        products: [{ model: `MODEL-${index % 5}`, name: `测试商品 ${index % 7}`, quantity: 1 }],
        status: 'pending',
        paymentStatus: 'unpaid',
        orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/W${String(index + 1).padStart(10, '0')}/synthetic-${index}`,
        officialOrderCreatedAt: new Date(now),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })),
      { validate: true }
    );
    await models.PaymentTask.bulkCreate(
      orders.map(order => ({
        orderId: order.id,
        processingStatus: 'pending',
        deadlineAt: new Date(now + 30 * 60_000),
        deadlineSource: 'official',
        paymentLinkSource: 'order_url',
      }))
    );

    const result = await dispatchService.runDispatchScan(500);
    const counts = await models.PaymentTask.findAll({
      attributes: [
        'assigneeUserId',
        [models.Sequelize.fn('COUNT', models.Sequelize.col('id')), 'count'],
      ],
      group: ['assigneeUserId'],
      raw: true,
    });

    expect(result.assigned).toBe(150);
    expect(counts.map(row => Number(row.count)).sort((a, b) => a - b)).toEqual([75, 75]);
  });

  test('批量分配在同一事务校验并更新全部选中任务', async () => {
    const tasks = await models.PaymentTask.findAll({
      where: { assigneeUserId: staffOne.id, processingStatus: 'pending' },
      limit: 2,
      order: [['id', 'ASC']],
    });
    const result = await dispatchService.assignTasks(
      {
        tasks: tasks.map(task => ({ id: task.id, expectedVersion: task.version })),
        assigneeUserId: staffTwo.id,
        handoffConfirmed: true,
        reason: '批量转派测试',
        idempotencyKey: 'integration-batch-assignment',
      },
      admin.id
    );

    expect(result.count).toBe(2);
    expect(result.items.every(task => task.assignee.id === staffTwo.id)).toBe(true);
    expect(
      await models.PaymentTask.count({
        where: {
          id: { [models.Sequelize.Op.in]: tasks.map(task => task.id) },
          assigneeUserId: staffTwo.id,
        },
      })
    ).toBe(2);
  });

  test('批量分配任一任务校验失败时全部回滚', async () => {
    const tasks = await models.PaymentTask.findAll({
      where: { assigneeUserId: staffOne.id, processingStatus: 'pending' },
      include: [{ model: models.Order, as: 'order' }],
      limit: 2,
      order: [['id', 'ASC']],
    });
    const originalOfficialTime = tasks[1].order.officialOrderCreatedAt;
    await tasks[1].order.update({
      officialOrderCreatedAt: new Date(Date.now() - 31 * 60_000),
    });

    try {
      await expect(
        dispatchService.assignTasks(
          {
            tasks: tasks.map(task => ({ id: task.id, expectedVersion: task.version })),
            assigneeUserId: staffTwo.id,
            handoffConfirmed: true,
            reason: '批量原子回滚测试',
            idempotencyKey: 'integration-batch-assignment-rollback',
          },
          admin.id
        )
      ).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_NOT_ELIGIBLE' });
      const unchanged = await models.PaymentTask.findAll({
        where: { id: { [models.Sequelize.Op.in]: tasks.map(task => task.id) } },
      });
      expect(unchanged.every(task => task.assigneeUserId === staffOne.id)).toBe(true);
    } finally {
      await tasks[1].order.update({ officialOrderCreatedAt: originalOfficialTime });
    }
  });

  test('转派后原负责人立即失去任务范围，新负责人获得范围', async () => {
    const task = await models.PaymentTask.findOne({ where: { assigneeUserId: staffOne.id } });
    await dispatchService.assignTask(
      task.id,
      {
        assigneeUserId: staffTwo.id,
        expectedVersion: task.version,
        handoffConfirmed: true,
        reason: '集成测试转派',
        idempotencyKey: 'integration-transfer-1',
      },
      admin.id
    );

    await expect(paymentTaskService.getOwnTask(task.id, staffOne.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(paymentTaskService.getOwnTask(task.id, staffTwo.id)).resolves.toMatchObject({
      id: task.id,
    });
  });

  test.each(['pending', 'processing', 'completed', 'exception'])(
    '处理状态 %s 下均可登记付款人且不改变状态',
    async status => {
      const task = await models.PaymentTask.findOne();
      await task.update({ processingStatus: status });
      const before = await task.reload();
      await payerService.assignOrderPayer(
        task.orderId,
        {
          payerName: `付款人-${status}`,
          expectedVersion: (await models.Order.findByPk(task.orderId)).payerVersion,
          reason: '四态付款人登记测试',
          idempotencyKey: `payer-${status}`,
        },
        admin.id,
        { assigneeUserId: before.assigneeUserId }
      );
      expect((await task.reload()).processingStatus).toBe(status);
    }
  );

  test('撤销付款权限会同步关闭自动接单，后续分配拒绝该用户', async () => {
    await permissionService.replaceUserPermissions(
      staffOne.id,
      {
        permissions: [],
        expectedVersion: staffOne.permissionsVersion,
        reason: '集成测试撤权',
        idempotencyKey: 'integration-revoke-1',
      },
      admin.id
    );
    const setting = await models.PaymentStaffSetting.findOne({ where: { userId: staffOne.id } });
    expect(setting.autoAssignEnabled).toBe(false);

    const candidateTask = await models.PaymentTask.findOne({
      where: { assigneeUserId: staffTwo.id, processingStatus: 'pending' },
    });
    await candidateTask.update({ assigneeUserId: null, version: candidateTask.version + 1 });
    await expect(
      dispatchService.assignTask(
        candidateTask.id,
        {
          assigneeUserId: staffOne.id,
          expectedVersion: candidateTask.version,
          idempotencyKey: 'integration-assign-after-revoke',
        },
        admin.id
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('撤权与分配并发时共用调度锁，撤权落库后不再接受新分配', async () => {
    const permissionCodes =
      require('../src/constants/permissionCatalog').PAYMENT_EXECUTION_PERMISSIONS;
    let currentUser = await models.User.findByPk(staffOne.id);
    await permissionService.replaceUserPermissions(
      staffOne.id,
      {
        permissions: permissionCodes,
        expectedVersion: currentUser.permissionsVersion,
        reason: '并发测试前恢复权限',
        idempotencyKey: 'integration-restore-before-race',
      },
      admin.id
    );
    await models.PaymentStaffSetting.update(
      { autoAssignEnabled: true },
      { where: { userId: staffOne.id } }
    );
    const task = await models.PaymentTask.findOne({
      where: { assigneeUserId: staffTwo.id, processingStatus: 'pending' },
    });
    await task.update({ assigneeUserId: null, version: task.version + 1 });
    currentUser = await models.User.findByPk(staffOne.id);

    const [revokeResult, assignmentResult] = await Promise.allSettled([
      permissionService.replaceUserPermissions(
        staffOne.id,
        {
          permissions: [],
          expectedVersion: currentUser.permissionsVersion,
          reason: '并发撤权测试',
          idempotencyKey: 'integration-concurrent-revoke',
        },
        admin.id
      ),
      dispatchService.assignTask(
        task.id,
        {
          assigneeUserId: staffOne.id,
          expectedVersion: task.version,
          idempotencyKey: 'integration-concurrent-assignment',
        },
        admin.id
      ),
    ]);

    expect(revokeResult.status).toBe('fulfilled');
    expect(['fulfilled', 'rejected']).toContain(assignmentResult.status);
    expect(
      await permissionService.getEffectivePermissions(await models.User.findByPk(staffOne.id))
    ).toEqual([]);
    expect(
      (await models.PaymentStaffSetting.findOne({ where: { userId: staffOne.id } }))
        .autoAssignEnabled
    ).toBe(false);

    const nextTask = await models.PaymentTask.findOne({
      where: { assigneeUserId: staffTwo.id, processingStatus: 'pending' },
    });
    await nextTask.update({ assigneeUserId: null, version: nextTask.version + 1 });
    await expect(
      dispatchService.assignTask(
        nextTask.id,
        {
          assigneeUserId: staffOne.id,
          expectedVersion: nextTask.version,
          idempotencyKey: 'integration-post-race-assignment',
        },
        admin.id
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('管理员关闭自动接单时仍可在容量内手动分配给自己', async () => {
    await dispatchService.updateStaffSettings(
      admin.id,
      { autoAssignEnabled: false, maxActiveTasks: 2, expectedVersion: 0 },
      admin.id
    );
    const task = await models.PaymentTask.findOne({
      where: { assigneeUserId: staffTwo.id, processingStatus: 'pending' },
    });
    await task.update({ assigneeUserId: null, version: task.version + 1 });

    await dispatchService.assignTask(
      task.id,
      {
        assigneeUserId: admin.id,
        expectedVersion: task.version,
        idempotencyKey: 'integration-admin-manual-assignment',
      },
      admin.id
    );

    expect((await task.reload()).assigneeUserId).toBe(admin.id);
  });

  test('本人任务查询、四态更新和订单链接都执行范围与版本检查', async () => {
    const listed = await paymentTaskService.listOwnTasks(staffTwo.id, {
      processingStatus: 'pending',
      orderNumber: 'W000000',
      productModel: 'MODEL-1',
      productKeyword: '测试商品',
      limit: 10,
    });
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items.every(item => item.assignee.id === staffTwo.id)).toBe(true);

    const task = await models.PaymentTask.findOne({
      where: { assigneeUserId: staffTwo.id, processingStatus: 'pending' },
    });
    const started = await paymentTaskService.updateOwnTask(
      task.id,
      {
        processingStatus: 'processing',
        processingNotes: '开始处理',
        expectedVersion: task.version,
        idempotencyKey: 'integration-status-processing',
      },
      staffTwo.id
    );
    expect(started.processingStatus).toBe('processing');
    const link = await paymentTaskService.getOwnPaymentLink(task.id, staffTwo.id);
    expect(link.paymentUrl).toContain(started.orderNumber);

    const completed = await paymentTaskService.updateOwnTask(
      task.id,
      {
        processingStatus: 'completed',
        processingNotes: '人工完成，等待官网确认',
        expectedVersion: started.version,
        idempotencyKey: 'integration-status-completed',
      },
      staffTwo.id
    );
    expect(completed.processingStatus).toBe('completed');
    const unrestrictedOrderUrl = 'https://example.invalid/synthetic-order-link';
    await models.Order.update(
      { orderUrl: unrestrictedOrderUrl, paymentStatus: 'paid', status: 'completed' },
      { where: { id: task.orderId } }
    );
    await models.PaymentTask.update(
      {
        deadlineAt: new Date(Date.now() - 60_000),
        eligibilityValidUntil: new Date(Date.now() - 60_000),
      },
      { where: { id: task.id } }
    );
    await expect(
      paymentTaskService.updateOwnTask(
        task.id,
        {
          processingStatus: 'processing',
          processingNotes: '非法回退',
          expectedVersion: completed.version,
          idempotencyKey: 'integration-status-invalid',
        },
        staffTwo.id
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(paymentTaskService.getOwnPaymentLink(task.id, staffTwo.id)).resolves.toMatchObject(
      {
        paymentUrl: unrestrictedOrderUrl,
      }
    );
    await expect(
      paymentTaskService.listOwnTasks(staffTwo.id, { processingStatus: 'not-a-status' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('行级保存只更新变化字段并原子提交状态、备注与付款人', async () => {
    const task = await models.PaymentTask.findOne({
      where: { assigneeUserId: staffTwo.id, processingStatus: 'pending' },
    });
    const order = await models.Order.findByPk(task.orderId);
    const beforeTaskVersion = task.version;
    const beforePayerVersion = order.payerVersion;

    const saved = await paymentTaskService.updateOwnTask(
      task.id,
      {
        processingStatus: 'processing',
        processingNotes: '原子保存测试',
        expectedVersion: beforeTaskVersion,
        payerName: '外部付款人原子测试',
        expectedPayerVersion: beforePayerVersion,
        idempotencyKey: 'integration-row-save-atomic',
      },
      staffTwo.id,
      { canHandle: true, canEditPayer: true }
    );

    expect(saved).toMatchObject({
      processingStatus: 'processing',
      processingNotes: '原子保存测试',
      payerName: '外部付款人原子测试',
      version: beforeTaskVersion + 1,
      payerVersion: beforePayerVersion + 1,
    });
    expect(
      await models.PaymentTaskEvent.count({
        where: { paymentTaskId: task.id, idempotencyKey: 'integration-row-save-atomic' },
      })
    ).toBe(1);
    expect(
      await models.OrderPayerEvent.count({
        where: { orderId: task.orderId, idempotencyKey: 'integration-row-save-atomic' },
      })
    ).toBe(1);
    const replayed = await paymentTaskService.updateOwnTask(
      task.id,
      {
        processingStatus: 'processing',
        processingNotes: '原子保存测试',
        expectedVersion: beforeTaskVersion,
        payerName: '外部付款人原子测试',
        expectedPayerVersion: beforePayerVersion,
        idempotencyKey: 'integration-row-save-atomic',
      },
      staffTwo.id,
      { canHandle: true, canEditPayer: true }
    );
    expect(replayed).toMatchObject({
      version: beforeTaskVersion + 1,
      payerVersion: beforePayerVersion + 1,
    });
  });

  test('行级保存失败时付款人不发生部分写入', async () => {
    const task = await models.PaymentTask.findOne({
      where: { assigneeUserId: staffTwo.id, processingStatus: 'pending' },
    });
    const order = await models.Order.findByPk(task.orderId);

    await expect(
      paymentTaskService.updateOwnTask(
        task.id,
        {
          processingStatus: 'exception',
          processingNotes: '',
          expectedVersion: task.version,
          payerName: '不应写入的付款人',
          expectedPayerVersion: order.payerVersion,
          idempotencyKey: 'integration-row-save-rollback',
        },
        staffTwo.id,
        { canHandle: true, canEditPayer: true }
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    expect((await models.Order.findByPk(order.id)).payerName).toBe(order.payerName);
    expect(
      await models.OrderPayerEvent.count({
        where: { orderId: order.id, idempotencyKey: 'integration-row-save-rollback' },
      })
    ).toBe(0);
  });

  test('只修改付款人不增加任务版本，且按实际字段检查权限', async () => {
    const task = await models.PaymentTask.findOne({ where: { assigneeUserId: staffTwo.id } });
    const order = await models.Order.findByPk(task.orderId);
    const beforeTaskVersion = task.version;
    const saved = await paymentTaskService.updateOwnTask(
      task.id,
      {
        payerName: '仅付款人字段',
        expectedPayerVersion: order.payerVersion,
        idempotencyKey: 'integration-row-save-payer-only',
      },
      staffTwo.id,
      { canHandle: false, canEditPayer: true }
    );
    expect(saved.version).toBe(beforeTaskVersion);
    expect(saved.payerName).toBe('仅付款人字段');

    await expect(
      paymentTaskService.updateOwnTask(
        task.id,
        {
          processingNotes: '无处理权限',
          expectedVersion: beforeTaskVersion,
          idempotencyKey: 'integration-row-save-forbidden',
        },
        staffTwo.id,
        { canHandle: false, canEditPayer: true }
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test('本人刷新进度仅允许当前负责人查询同一订单任务', async () => {
    const task = await models.PaymentTask.findOne({ where: { assigneeUserId: staffTwo.id } });
    const queued = await paymentTaskService.refreshOwnTask(task.id, staffTwo.id);
    expect(queued).toMatchObject({ jobId: expect.any(Number), status: 'pending' });
    await expect(
      paymentTaskService.getOwnRefreshJob(task.id, queued.jobId, staffTwo.id)
    ).resolves.toMatchObject({ id: queued.jobId, status: 'pending' });
    await expect(
      paymentTaskService.getOwnRefreshJob(task.id, queued.jobId, staffOne.id)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test('自由文本付款人登记保持幂等、审计与乐观锁', async () => {
    const task = await models.PaymentTask.findOne({ where: { assigneeUserId: staffTwo.id } });
    const order = await models.Order.findByPk(task.orderId);
    const initialEventCount = await models.OrderPayerEvent.count({ where: { orderId: order.id } });
    const assigned = await payerService.assignOrderPayer(
      order.id,
      {
        payerName: '  外部付款人甲  ',
        expectedVersion: order.payerVersion,
        idempotencyKey: 'integration-payer-name',
      },
      staffTwo.id,
      { assigneeUserId: staffTwo.id }
    );
    expect(assigned.payerName).toBe('外部付款人甲');
    await expect(
      payerService.assignOrderPayer(
        order.id,
        {
          payerName: '外部付款人乙',
          expectedVersion: order.payerVersion,
          idempotencyKey: 'integration-payer-stale',
        },
        staffTwo.id,
        { assigneeUserId: staffTwo.id }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    const replayed = await payerService.assignOrderPayer(
      order.id,
      {
        payerName: '不会覆盖',
        expectedVersion: order.payerVersion,
        idempotencyKey: 'integration-payer-name',
      },
      staffTwo.id,
      { assigneeUserId: staffTwo.id }
    );
    expect(replayed.replayed).toBe(true);
    expect(replayed.payerName).toBe('外部付款人甲');
    expect(await models.OrderPayerEvent.count({ where: { orderId: order.id } })).toBe(
      initialEventCount + 1
    );
  });

  test('调度配置、组合筛选、批量刷新和重开均保留输入边界', async () => {
    const overview = await dispatchService.getDispatchOverview();
    expect(overview.staff.some(person => person.id === admin.id)).toBe(true);
    const settings = await dispatchService.updateDispatchSettings(
      {
        enabled: true,
        mode: 'manual',
        expectedVersion: overview.settings.version,
      },
      admin.id
    );
    expect(settings.mode).toBe('manual');
    await expect(dispatchService.listDispatchTasks({ assignee: 'invalid' })).rejects.toMatchObject({
      statusCode: 400,
    });
    const queue = await dispatchService.listDispatchTasks({
      processingStatus: 'pending',
      orderNumber: 'W000000',
      productKeyword: '测试商品',
      officialOrderStatus: 'pending',
      limit: 5,
    });
    expect(queue.items.length).toBeLessThanOrEqual(5);
    expect(queue.items.every(item => item.officialOrderCreatedAt)).toBe(true);

    const staffQueue = await dispatchService.listDispatchTasks({
      assignee: String(staffTwo.id),
      limit: 5,
    });
    expect(staffQueue.items.length).toBeGreaterThan(0);
    expect(staffQueue.items.every(item => item.assignee.id === staffTwo.id)).toBe(true);

    const refreshTasks = await models.PaymentTask.findAll({
      where: { processingStatus: 'pending' },
      limit: 2,
      order: [['id', 'ASC']],
    });
    const refresh = await dispatchService.refreshTasks(
      refreshTasks.map(task => task.id),
      admin.id
    );
    expect(refresh.total).toBe(2);
    const task = refreshTasks[0];
    await task.update({ processingStatus: 'completed', version: task.version + 1 });
    const reopened = await dispatchService.reopenTask(
      task.id,
      {
        reason: '官网状态需要复核',
        expectedVersion: task.version,
        idempotencyKey: 'integration-reopen',
      },
      admin.id
    );
    expect(reopened.processingStatus).toBe('exception');
  });

  test('权限读取、幂等重试和原子创建普通用户使用数据库显式集合', async () => {
    const current = await permissionService.getUserPermissions(staffOne.id);
    expect(current.permissions).toEqual([]);
    const created = await permissionService.createUserWithPermissions(
      {
        username: 'integration_new_staff',
        password: 'synthetic-password',
        role: 'operator',
        status: 'active',
        forcePasswordChange: true,
      },
      [require('../src/constants/business').PERMISSIONS.PAYMENT_TASKS_READ_OWN],
      admin.id
    );
    expect(created.permissions).toEqual([
      require('../src/constants/business').PERMISSIONS.PAYMENT_TASKS_READ_OWN,
    ]);
    const latest = await models.User.findByPk(staffOne.id);
    const changed = await permissionService.replaceUserPermissions(
      staffOne.id,
      {
        permissions: [],
        expectedVersion: latest.permissionsVersion,
        reason: '幂等空集合写入',
        idempotencyKey: 'integration-permission-idempotent',
      },
      admin.id
    );
    const replay = await permissionService.replaceUserPermissions(
      staffOne.id,
      {
        permissions: [],
        expectedVersion: changed.version,
        idempotencyKey: 'integration-permission-idempotent',
      },
      admin.id
    );
    expect(replay.permissions).toEqual([]);
  });
});
