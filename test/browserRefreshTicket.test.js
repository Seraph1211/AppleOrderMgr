const jwt = require('jsonwebtoken');
const {
  issueBrowserTicket,
  verifyBrowserTicket,
} = require('../src/services/crawler/browserRefreshTicket');
const secretBefore = process.env.JWT_SECRET;
const secret = 'browser-ticket-unit-test-secret-with-adequate-length';
const user = { id: 1, sessionId: 'session-one' };
const order = {
  id: 7,
  orderNumber: 'W1234567890',
  orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com',
  updatedAt: new Date('2026-09-20T00:00:00Z'),
};

beforeEach(() => {
  process.env.JWT_SECRET = secret;
});
afterEach(() => {
  jest.useRealTimers();
});
afterAll(() => {
  if (secretBefore === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = secretBefore;
});

test('票据绑定订单版本，但不含访问链接且不能作为登录 JWT', () => {
  const { token, expiresAt } = issueBrowserTicket(order, user);
  expect(verifyBrowserTicket(token, order, user)).toMatchObject({
    orderId: 7,
    version: order.updatedAt.toISOString(),
  });
  expect(JSON.stringify(jwt.decode(token))).not.toContain('example.com');
  expect(() => jwt.verify(token, secret)).toThrow();
  expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
});

test.each([
  { id: 2, sessionId: 'session-one' },
  { id: 1, sessionId: 'session-two' },
])('不能跨账号或登录会话使用', otherUser => {
  const { token } = issueBrowserTicket(order, user);
  expect(() => verifyBrowserTicket(token, order, otherUser)).toThrow(
    expect.objectContaining({ code: 'BROWSER_TICKET_INVALID' })
  );
});

test('不能跨订单使用', () => {
  const { token } = issueBrowserTicket(order, user);
  expect(() => verifyBrowserTicket(token, { ...order, id: 8 }, user)).toThrow(
    expect.objectContaining({ code: 'BROWSER_TICKET_INVALID' })
  );
});

test.each([
  { updatedAt: new Date('2026-09-20T00:00:00.001Z') },
  { orderUrl: order.orderUrl + 'changed' },
  { orderNumber: 'W9999999999' },
])('订单版本、链接、身份变化后票据失效', changes => {
  const { token } = issueBrowserTicket(order, user);
  expect(() => verifyBrowserTicket(token, { ...order, ...changes }, user)).toThrow(
    expect.objectContaining({ code: 'BROWSER_ORDER_CHANGED' })
  );
});

test('过期或篡改票据均拒绝', () => {
  jest.useFakeTimers();
  const { token } = issueBrowserTicket(order, user);
  expect(() => verifyBrowserTicket(token + 'bad', order, user)).toThrow();
  jest.advanceTimersByTime(121000);
  expect(() => verifyBrowserTicket(token, order, user)).toThrow(
    expect.objectContaining({ code: 'BROWSER_TICKET_INVALID' })
  );
});

test('隔离批次票据 330 秒、采集 300 秒，扩展默认时限不变且拒绝任意模式', () => {
  jest.useFakeTimers();
  expect(issueBrowserTicket(order, user).maxDurationMs).toBe(90000);
  const { token, maxDurationMs } = issueBrowserTicket(order, user, 'isolated_batch');
  expect(maxDurationMs).toBe(300000);
  jest.advanceTimersByTime(121000);
  expect(verifyBrowserTicket(token, order, user).mode).toBe('isolated_batch');
  jest.advanceTimersByTime(210000);
  expect(() => verifyBrowserTicket(token, order, user)).toThrow();
  expect(() => issueBrowserTicket(order, user, 'unlimited')).toThrow();
});
