const express = require('express');
function request(app) {
  return {
    post: route => ({
      send: body => ({
        expect: async status => {
          const server = app.listen(0, '127.0.0.1');
          try {
            await new Promise(resolve => server.once('listening', resolve));
            const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Connection: 'close' },
              body: JSON.stringify(body),
            });
            const result = await response.json();
            expect(response.status).toBe(status);
            return { body: result };
          } finally {
            await new Promise(resolve => server.close(resolve));
          }
        },
      }),
    }),
  };
}
jest.mock('../src/models', () => ({ Order: { findOne: jest.fn() } }));
jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../src/services/crawlerService', () => ({
  validateOrderUrl: jest.fn(),
  crawlAndUpdateOrder: jest.fn(),
}));
jest.mock('../src/services/crawler/refreshJobRepository', () => ({ ensureSystemState: jest.fn() }));
jest.mock('../src/services/crawler/crawlerRateLimiter', () => ({ acquire: jest.fn() }));
jest.mock('../src/services/permissionService', () => ({}));
const { Order } = require('../src/models');
const crawler = require('../src/services/crawlerService');
const repository = require('../src/services/crawler/refreshJobRepository');
const limiter = require('../src/services/crawler/crawlerRateLimiter');
const controller = require('../src/controllers/browserRefreshController');
const { requireRole, requirePermission } = require('../src/middleware/authMiddleware');
const asyncHandler = require('../src/utils/asyncHandler');
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
const savedSecret = process.env.JWT_SECRET;
const savedFlag = process.env.BROWSER_ORDER_REFRESH_ENABLED;
const order = {
  id: 7,
  orderNumber: 'W1234567890',
  orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com',
  updatedAt: new Date('2026-09-20T00:00:00Z'),
};
const user = { id: 1, sessionId: 'one', role: 'admin', permissions: ['orders.refresh'] };

function appFor(actor = user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = actor;
    next();
  });
  for (const [route, handler] of [
    ['start', controller.startBrowserRefresh],
    ['permit', controller.permitBrowserRequest],
    ['result', controller.completeBrowserRefresh],
  ]) {
    app.post(
      `/:id/${route}`,
      requireRole(['admin']),
      requirePermission('orders.refresh'),
      asyncHandler(handler)
    );
  }
  app.use((error, _req, res, _next) =>
    res.status(error.statusCode || 500).json({ error: { code: error.code || 'ERROR' } })
  );
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = 'browser-refresh-controller-test-secret-long';
  process.env.BROWSER_ORDER_REFRESH_ENABLED = 'true';
  Order.findOne.mockResolvedValue(order);
  repository.ensureSystemState.mockResolvedValue({ isPaused: false });
  limiter.acquire.mockResolvedValue();
  crawler.crawlAndUpdateOrder.mockResolvedValue({ success: true, orderId: 7 });
});
afterAll(() => {
  for (const [key, value] of [
    ['JWT_SECRET', savedSecret],
    ['BROWSER_ORDER_REFRESH_ENABLED', savedFlag],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test.each(['start', 'permit', 'result'])('普通账号即使有刷新权限也不能使用 %s', async route => {
  await request(appFor({ ...user, role: 'user' }))
    .post(`/7/${route}`)
    .send({})
    .expect(403);
  expect(Order.findOne).not.toHaveBeenCalled();
});

test('默认关闭、无权限和不存在订单时不能创建任务', async () => {
  delete process.env.BROWSER_ORDER_REFRESH_ENABLED;
  await request(appFor()).post('/7/start').send({}).expect(503);
  await request(appFor({ ...user, permissions: [] }))
    .post('/7/start')
    .send({})
    .expect(403);
  process.env.BROWSER_ORDER_REFRESH_ENABLED = 'true';
  Order.findOne.mockResolvedValue(null);
  await request(appFor()).post('/7/start').send({}).expect(404);
});

test('暂停时不能启动采集或取得请求许可', async () => {
  const app = appFor();
  const initial = await request(app).post('/7/start').send({}).expect(200);
  repository.ensureSystemState.mockResolvedValue({ isPaused: true });
  await request(app).post('/7/start').send({}).expect(409);
  await request(app).post('/7/permit').send({ ticket: initial.body.data.ticket }).expect(409);
  expect(limiter.acquire).not.toHaveBeenCalled();
});

test('有效任务每次请求使用全局限流，回传复用版本保护并剔除非业务字段', async () => {
  const app = appFor();
  const initial = await request(app).post('/7/start').send({}).expect(200);
  const { ticket } = initial.body.data;
  await request(app).post('/7/permit').send({ ticket }).expect(200);
  expect(limiter.acquire).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  const orderJson = buildLifecycleJson('PROCESSING');
  orderJson.cookie = 'not-forwarded';
  await request(app)
    .post('/7/result')
    .send({
      ticket,
      page: {
        pageUrl: 'https://secure8.www.apple.com.cn/shop/order/guest/W1234567890/redacted',
        orderJson,
      },
    })
    .expect(200);
  const [id, options] = crawler.crawlAndUpdateOrder.mock.calls[0];
  expect(id).toBe(7);
  expect(options).toMatchObject({ manual: true, expectedUpdatedAt: order.updatedAt.toISOString() });
  const page = await options.acquireOrderPage();
  expect(JSON.stringify(page)).not.toContain('not-forwarded');
});

test('更新版本后重复票据提交拒绝，未调用订单更新', async () => {
  const app = appFor();
  const initial = await request(app).post('/7/start').send({}).expect(200);
  Order.findOne.mockResolvedValue({ ...order, updatedAt: new Date('2026-09-20T00:00:01Z') });
  await request(app).post('/7/result').send({ ticket: initial.body.data.ticket }).expect(409);
  expect(crawler.crawlAndUpdateOrder).not.toHaveBeenCalled();
});

test('拒绝含原始访客令牌或 HTML 的回传', async () => {
  const app = appFor();
  const initial = await request(app).post('/7/start').send({}).expect(200);
  await request(app)
    .post('/7/result')
    .send({
      ticket: initial.body.data.ticket,
      page: {
        pageUrl: 'https://secure8.www.apple.com.cn/shop/order/guest/W1234567890/token',
        orderJson: {},
      },
    })
    .expect(400);
  expect(crawler.crawlAndUpdateOrder).not.toHaveBeenCalled();
});

test('隔离批次返回受控的采集预算，旧扩展预算不变，非法模式拒绝', async () => {
  const app = appFor();
  const batch = await request(app).post('/7/start').send({ mode: 'isolated_batch' }).expect(200);
  expect(batch.body.data).toMatchObject({ maxDurationMs: 300000, maxRequests: 100 });
  const extension = await request(app).post('/7/start').send({}).expect(200);
  expect(extension.body.data.maxDurationMs).toBe(90000);
  await request(app).post('/7/start').send({ mode: 'unlimited' }).expect(400);
});
