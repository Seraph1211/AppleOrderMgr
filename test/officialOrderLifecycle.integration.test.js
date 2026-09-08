/* eslint-disable camelcase -- 隔离库 SQL 返回真实 snake_case 字段 */
jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/utils/telegramNotifier', () => ({ sendTelegramAlert: jest.fn() }));
jest.mock('../src/services/crawler/crawlerRateLimiter', () => ({ acquire: jest.fn() }));
jest.mock('../src/utils/proxyManager', () => ({
  getStatus: () => ({ isInitialized: true }),
  getNextProxy: () => ({ host: '127.0.0.1', port: 1234 }),
  recordProxySuccess: jest.fn(),
  recordProxyFailure: jest.fn(),
}));

const enabled = process.env.RUN_LIFECYCLE_DB_INTEGRATION === 'true';
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
const axios = require('axios');

(enabled ? describe : describe.skip)('官网生命周期隔离库开发自测（外部 I/O 全 Mock）', () => {
  let models;
  let crawler;
  let repository;
  let dispatch;
  let admin;
  let originalProxyEnabled;
  let order;
  let sequence = 6000000000;
  const page = (status, change = () => {}) => {
    const json = buildLifecycleJson(status);
    json.orderDetail.orderHeader.d.orderNumber = order.orderNumber;
    change(json);
    axios.get.mockResolvedValue({
      data: `<script id="init_data">${JSON.stringify(json)}</script>`,
      status: 200,
    });
  };

  beforeAll(async () => {
    if (
      process.env.DB_NAME !== 'apple_order_mgr_lifecycle_test_20260909' ||
      process.env.DATABASE_URL
    ) {
      throw new Error('只允许指定的可丢弃隔离测试库，且禁用 DATABASE_URL');
    }
    models = require('../src/models');
    await models.sequelize.authenticate();
    await models.sequelize.query('TRUNCATE TABLE orders, users RESTART IDENTITY CASCADE');
    crawler = require('../src/services/crawlerService');
    repository = require('../src/services/crawler/refreshJobRepository');
    dispatch = require('../src/services/paymentDispatchService');
    originalProxyEnabled = require('../src/utils/config').config.proxy.enabled;
    require('../src/utils/config').config.proxy.enabled = true;
    admin = await models.User.create({
      username: 'lifecycle_admin',
      password: 'synthetic-password',
      role: 'admin',
      status: 'active',
      forcePasswordChange: false,
    });
    await models.PaymentStaffSetting.create({
      userId: admin.id,
      autoAssignEnabled: false,
      maxActiveTasks: 100,
    });
  });
  afterAll(async () => {
    if (models) {
      require('../src/utils/config').config.proxy.enabled = originalProxyEnabled;
      await models.sequelize.close();
    }
  });
  beforeEach(async () => {
    axios.get.mockReset();
    sequence++;
    order = await models.Order.create({
      orderNumber: `W${sequence}`,
      appleId: 'synthetic@example.com',
      orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/W${sequence}/synthetic@example.com`,
      status: 'pending',
      paymentStatus: 'unpaid',
      paymentMethod: '银行卡',
      products: [{ name: '测试手机 256GB 蓝色', model: 'MODEL-1', quantity: 2 }],
    });
  });

  test('五阶段落库、来源快照幂等、准确截止同步，不篡改人工付款任务四态', async () => {
    const task = await models.PaymentTask.create({
      orderId: order.id,
      processingStatus: 'processing',
    });
    page('PAYMENT_DUE_STORED_ORDER');
    await crawler.crawlAndUpdateOrder(order.id);
    await order.reload();
    const source = order.sourceSnapshot;
    const expiry = order.officialPaymentExpiresAt;
    expect(order.products[0].quantity).toBe(1);
    expect(order.officialOrderCreatedAt).toBeNull();
    expect(order.autoRefreshEnabled).toBe(true);
    await task.reload();
    expect(task.deadlineAt).toEqual(expiry);
    expect(task.version).toBe(1);
    for (const status of ['PAYMENT_RECEIVED', 'PROCESSING', 'READY_FOR_PICKUP', 'PICKED_UP']) {
      page(status);
      await crawler.crawlAndUpdateOrder(order.id, { manual: true });
      await order.reload();
      expect(order.autoRefreshEnabled).toBe(false);
      expect(order.sourceSnapshot).toEqual(source);
      expect(order.officialPaymentExpiresAt).toEqual(expiry);
      expect(Number(order.officialOrderAmount)).toBe(8999);
      expect(order.validationIssues).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'source_conflict' })])
      );
    }
    await task.reload();
    expect(task.processingStatus).toBe('processing');
    expect(order.status).toBe('picked_up');
    const logs = await models.CrawlLog.findAll({ where: { orderId: order.id }, raw: true });
    expect(logs).toHaveLength(5);
    expect(logs.every(log => log.crawledData === null)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('synthetic@example.com');
  });

  test('付款后已排队自动任务和 page_open 无网络请求，手动仍可刷新', async () => {
    await order.update({ status: 'payment_received', paymentStatus: 'paid' });
    expect(await crawler.crawlAndUpdateOrder(order.id)).toMatchObject({ skipped: true });
    expect(
      await crawler.crawlAndUpdateOrder(order.id, { source: 'page_open', manual: true })
    ).toMatchObject({ skipped: true });
    expect(axios.get).not.toHaveBeenCalled();
    page('READY_FOR_PICKUP');
    await crawler.crawlAndUpdateOrder(order.id, { manual: true });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('错单仅记录安全异常，不跨单覆盖，禁止新付款分配', async () => {
    page('PAYMENT_RECEIVED', json => {
      json.orderDetail.orderHeader.d.orderNumber = 'W9999999999';
    });
    await expect(crawler.crawlAndUpdateOrder(order.id, { manual: true })).rejects.toMatchObject({
      eventType: 'order_identity',
    });
    await order.reload();
    expect(order.orderNumber).toBe(`W${sequence}`);
    expect(order.paymentStatus).toBe('unpaid');
    expect(order.products[0].quantity).toBe(2);
    expect(order.sourceSnapshot).toBeNull();
    expect(order.autoRefreshEnabled).toBe(false);
    expect(order.validationIssues[0].type).toBe('order_identity');
    expect(JSON.stringify(order.validationIssues)).not.toContain('W9999999999');
    const task = await models.PaymentTask.create({
      orderId: order.id,
      processingStatus: 'pending',
    });
    await expect(
      dispatch.assignTask(
        task.id,
        {
          expectedVersion: task.version,
          assigneeUserId: admin.id,
          idempotencyKey: `lifecycle-${task.id}-${task.version}`,
        },
        admin.id
      )
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_ELIGIBLE' });
  });

  test('官网结果晚于并发编辑时拒绝覆盖', async () => {
    const json = buildLifecycleJson('PAYMENT_RECEIVED');
    json.orderDetail.orderHeader.d.orderNumber = order.orderNumber;
    axios.get.mockImplementation(async () => {
      await models.Order.update({ notes: '并发修改' }, { where: { id: order.id } });
      return { data: `<script id="init_data">${JSON.stringify(json)}</script>` };
    });
    await expect(crawler.crawlAndUpdateOrder(order.id, { manual: true })).rejects.toMatchObject({
      eventType: 'concurrency',
    });
    await order.reload();
    expect(order.status).toBe('pending');
    expect(order.crawlFailCount).toBe(0);
  });

  test('日志写入失败回滚订单、来源快照和付款任务截止', async () => {
    const task = await models.PaymentTask.create({
      orderId: order.id,
      processingStatus: 'pending',
    });
    page('PAYMENT_DUE_STORED_ORDER');
    const spy = jest
      .spyOn(models.CrawlLog, 'create')
      .mockRejectedValueOnce(new Error('synthetic rollback'));
    try {
      await expect(crawler.crawlAndUpdateOrder(order.id, { manual: true })).rejects.toThrow(
        'synthetic rollback'
      );
      await order.reload();
      await task.reload();
      expect(order.sourceSnapshot).toBeNull();
      expect(order.officialPaymentExpiresAt).toBeNull();
      expect(order.products[0].quantity).toBe(2);
      expect(task.deadlineAt).toBeNull();
      expect(task.version).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('只有准确截止、没有精确创建时间仍可分配；付款后不可新分配', async () => {
    await order.update({
      status: 'payment_due',
      officialPaymentExpiresAt: new Date(Date.now() + 600000),
    });
    const task = await models.PaymentTask.create({
      orderId: order.id,
      processingStatus: 'pending',
    });
    await dispatch.assignTask(
      task.id,
      {
        expectedVersion: task.version,
        assigneeUserId: admin.id,
        idempotencyKey: `lifecycle-${task.id}-${task.version}`,
      },
      admin.id
    );
    await task.reload();
    expect(task.assigneeUserId).toBe(admin.id);
    await order.update({ paymentStatus: 'paid', status: 'payment_received' });
    await expect(
      dispatch.assignTask(
        task.id,
        {
          expectedVersion: task.version,
          assigneeUserId: admin.id,
          idempotencyKey: `lifecycle-${task.id}-${task.version}`,
        },
        admin.id
      )
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_ELIGIBLE' });
  });

  test('混合商品阶段禁止新分配', async () => {
    await order.update({
      status: 'unknown',
      officialStatusNeedsReview: true,
      officialPaymentExpiresAt: new Date(Date.now() + 600000),
    });
    const task = await models.PaymentTask.create({
      orderId: order.id,
      processingStatus: 'pending',
    });
    await expect(
      dispatch.assignTask(
        task.id,
        {
          expectedVersion: task.version,
          assigneeUserId: admin.id,
          idempotencyKey: `lifecycle-${task.id}-${task.version}`,
        },
        admin.id
      )
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_ELIGIBLE' });
  });

  test('跳过任务不改变刷新成功时间或清除已有错误', async () => {
    const timestamp = new Date('2026-09-01T00:00:00Z');
    await repository.upsertSchedule(order.id, {
      lastSuccessAt: timestamp,
      freshnessStatus: 'failed',
      lastErrorCode: 'HTTP_424',
      consecutiveFailures: 1,
    });
    const job = await models.OrderRefreshJob.create({
      orderId: order.id,
      trigger: 'auto',
      status: 'running',
      leaseOwner: 'synthetic-worker',
      scheduledAt: new Date(),
    });
    await repository.finishJob(job, { success: true, skipped: true, nextAutoRefreshAt: null });
    await job.reload();
    const schedule = await models.OrderRefreshSchedule.findOne({ where: { orderId: order.id } });
    expect(job.status).toBe('skipped');
    expect(schedule.lastSuccessAt).toEqual(timestamp);
    expect(schedule.lastErrorCode).toBe('HTTP_424');
    expect(schedule.consecutiveFailures).toBe(1);
    expect(schedule.nextAutoRefreshAt).toBeNull();
  });

  test('页面兼容入口不创建任务', async () => {
    const result =
      await require('../src/services/crawler/refreshJobService').enqueuePageOpenRefresh(
        [order.id],
        admin.id
      );
    expect(result).toMatchObject({ total: 0, created: 0, results: [] });
    expect(await models.OrderRefreshJob.count({ where: { orderId: order.id } })).toBe(0);
  });

  test('正式 Migration up → 校验 → down → up 保留历史字段并回退新增枚举', async () => {
    const migration = require('../migrations/20260908000004-add-official-order-lifecycle');
    const qi = models.sequelize.getQueryInterface();
    await order.update({ status: 'picked_up', pickupStatus: 'picked_up', paymentStatus: 'paid' });
    const columns = await qi.describeTable('orders');
    expect(columns.official_status_needs_review.allowNull).toBe(false);
    expect(columns.source_snapshot.allowNull).toBe(true);
    expect(
      (await qi.showIndex('orders')).some(
        index => index.name === 'idx_orders_official_payment_expires_at'
      )
    ).toBe(true);
    await migration.down(qi);
    try {
      expect((await qi.describeTable('orders')).source_snapshot).toBeUndefined();
      const [rows] = await models.sequelize.query(
        'SELECT status, payment_status, pickup_status FROM orders WHERE id = :id',
        { replacements: { id: order.id } }
      );
      expect(rows[0]).toEqual({
        status: 'completed',
        payment_status: 'paid',
        pickup_status: 'picked_up',
      });
    } finally {
      await migration.up(qi, models.Sequelize);
    }
    await order.reload();
    expect(order.status).toBe('completed');
    expect(order.sourceSnapshot).toBeNull();
    expect(order.officialStatusNeedsReview).toBe(false);
  });
});
