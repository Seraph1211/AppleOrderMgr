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
const enabled = process.env.RUN_INITIAL_REFRESH_DB_TEST === 'true';
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
const axios = require('axios');

(enabled ? describe : describe.skip)('首次刷新真实模型与事务回归（外部请求全 Mock）', () => {
  let models;
  let worker;
  let config;
  let originalProxy;
  let originalMaxRetry;
  let sequence = 7100000000;
  let order;
  beforeAll(async () => {
    if (process.env.DB_NAME !== 'aos_initial_refresh_test_20260913' || process.env.DATABASE_URL)
      throw new Error('仅允许本轮专用隔离数据库');
    models = require('../src/models');
    await models.sequelize.authenticate();
    await models.sequelize.query('TRUNCATE TABLE orders RESTART IDENTITY CASCADE');
    worker = require('../src/services/crawler/refreshWorkerService');
    config = require('../src/utils/config').config;
    originalProxy = config.proxy.enabled;
    originalMaxRetry = config.crawler.maxRetry;
    config.proxy.enabled = true;
  });
  afterAll(async () => {
    if (models) {
      config.proxy.enabled = originalProxy;
      config.crawler.maxRetry = originalMaxRetry;
      await models.sequelize.close();
    }
  });
  beforeEach(async () => {
    axios.get.mockReset();
    config.crawler.maxRetry = originalMaxRetry;
    sequence++;
    order = await models.Order.create({
      orderNumber: `W${sequence}`,
      appleId: 'synthetic@example.com',
      orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/W${sequence}/synthetic@example.com`,
      status: 'pending',
      paymentStatus: 'unknown',
      orderDate: new Date(),
      products: [{ name: '测试手机 256GB 蓝色', model: 'MODEL-1', quantity: 2 }],
    });
  });
  const execute = async trigger => {
    const job = await models.OrderRefreshJob.create({
      orderId: order.id,
      trigger,
      status: 'running',
      scheduledAt: new Date(),
      leaseOwner: 'synthetic-worker',
      leaseExpiresAt: new Date(Date.now() + 60000),
    });
    await worker.processJob(job);
    await job.reload();
    await order.reload();
    return job;
  };
  const respond = missingAmount => {
    const json = buildLifecycleJson('PAYMENT_DUE_STORED_ORDER');
    json.orderDetail.orderHeader.d.orderNumber = order.orderNumber;
    json.orderDetail.orderItems['orderItem-11'].orderItemDetails.d.paymentTimeToExpiryEpoch =
      Math.floor(Date.now() / 1000) + 600;
    if (missingAmount) json.orderDetail.orderHeader.payNow.d.totalAmount = '无法识别';
    axios.get.mockResolvedValue({
      status: 200,
      data: `<script id="init_data">${JSON.stringify(json)}</script>`,
    });
  };
  test.each(['initial', 'manual_single'])(
    '%s 成功提交官网字段、合法日志与任务结果，不安排周期刷新',
    async trigger => {
      respond(false);
      const job = await execute(trigger);
      expect(job.status).toBe('succeeded');
      expect(order.lastCrawledAt).toBeInstanceOf(Date);
      expect(Number(order.officialOrderAmount)).toBe(8999);
      const log = await models.CrawlLog.findOne({ where: { orderId: order.id, success: true } });
      expect(log.source).toBe(trigger === 'initial' ? 'auto' : 'manual');
      const schedule = await models.OrderRefreshSchedule.findOne({ where: { orderId: order.id } });
      expect(schedule.lastSuccessAt).toBeInstanceOf(Date);
      expect(schedule.nextAutoRefreshAt).toBeNull();
      expect(axios.get).toHaveBeenCalledTimes(1);
    }
  );
  test('首次刷新失败保留实际错误与失败日志，不再被来源校验覆盖', async () => {
    axios.get.mockRejectedValue(
      Object.assign(new Error('synthetic forbidden'), { response: { status: 403 } })
    );
    config.crawler.maxRetry = 1;
    const job = await execute('initial');
    expect(job.status).toBe('failed');
    expect(job.lastErrorCode).toBe('HTTP_403');
    const log = await models.CrawlLog.findOne({ where: { orderId: order.id, success: false } });
    expect(log).not.toBeNull();
    expect(log.source).toBe('auto');
    expect(log.httpStatus).toBe(403);
    expect(order.lastCrawledAt).toBeNull();
  });
  test('首次刷新金额异常仍提交其他字段并保存合法的警告日志', async () => {
    respond(true);
    const job = await execute('initial');
    expect(job.status).toBe('succeeded');
    expect(order.lastCrawledAt).toBeInstanceOf(Date);
    const warning = await models.CrawlLog.findOne({
      where: { orderId: order.id, event: 'official_amount_parse_missing' },
    });
    expect(warning).not.toBeNull();
    expect(warning.source).toBe('auto');
  });
});
