const { EventEmitter } = require('events');
const { collectBrowserOrder } = require('../src/services/crawler/browserBatch/batchCollector');
const { batchError } = require('../src/services/crawler/browserBatch/batchConfig');
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
const tick = () => new Promise(resolve => setImmediate(resolve));
let task;
beforeEach(() => {
  task = {
    orderNumber: 'W1234567890',
    ticket: 'test-ticket',
    orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com',
    expiresAt: new Date(Date.now() + 330000).toISOString(),
    maxRequests: 100,
    maxDurationMs: 300000,
  };
});
function harness(body = JSON.stringify(buildLifecycleJson('PROCESSING'))) {
  const session = new EventEmitter();
  session.send = jest.fn(method =>
    Promise.resolve(method === 'Network.getResponseBody' ? { body, base64Encoded: false } : {})
  );
  const page = new EventEmitter();
  const context = new EventEmitter();
  context.routeWebSocket = jest.fn(() => Promise.resolve());
  context.newPage = jest.fn(() => Promise.resolve(page));
  context.newCDPSession = jest.fn(() => Promise.resolve(session));
  context.close = jest.fn(() => Promise.resolve());
  const browser = new EventEmitter();
  browser.isConnected = () => true;
  browser.newContext = jest.fn(() => Promise.resolve(context));
  const permit = jest.fn(() => Promise.resolve());
  const start = (extra = {}) =>
    collectBrowserOrder({ browser, task, proxy: 'socks5://127.0.0.1:1080', permit, ...extra });
  const response = (status = 200, orderNumber = task.orderNumber) => {
    session.emit('Network.responseReceived', {
      type: 'Document',
      requestId: 'document',
      response: {
        status,
        mimeType: 'text/html',
        url: `https://secure8.www.apple.com.cn/shop/order/guest/${orderNumber}/private-token`,
      },
    });
    session.emit('Network.loadingFinished', {
      requestId: 'document',
      encodedDataLength: body.length,
    });
  };
  return { session, context, page, browser, permit, start, response };
}

test('隔离代理、重定向逐次许可，成功只回传白名单业务 JSON 及脱敏 URL', async () => {
  const h = harness();
  const result = h.start();
  await tick();
  let release;
  h.permit.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      })
  );
  h.session.emit('Fetch.requestPaused', { requestId: 'request1', resourceType: 'Document' });
  await tick();
  expect(
    h.session.send.mock.calls.filter(([method]) => method === 'Fetch.continueRequest')
  ).toHaveLength(0);
  release();
  await tick();
  h.session.emit('Fetch.requestPaused', { requestId: 'redirect2', resourceType: 'Document' });
  await tick();
  expect(h.permit).toHaveBeenCalledTimes(2);
  h.response();
  const page = await result;
  expect(page.pageUrl).toMatch(/\/redacted$/);
  expect(JSON.stringify(page)).not.toContain('private-token');
  expect(page.orderJson.orderDetail.orderHeader.d.orderNumber).toBe(task.orderNumber);
  expect(h.browser.newContext).toHaveBeenCalledWith(
    expect.objectContaining({
      proxy: { server: 'socks5://127.0.0.1:1080' },
      serviceWorkers: 'block',
    })
  );
  expect(h.context.close).toHaveBeenCalledTimes(1);
  expect(h.browser.listenerCount('disconnected')).toBe(0);
});

test.each([541, 429])('官网 %s 触发换代理错误并清理', async status => {
  const h = harness();
  const result = h.start();
  const assertion = expect(result).rejects.toThrow('APPLE_THROTTLED');
  await tick();
  h.response(status);
  await assertion;
  expect(h.context.close).toHaveBeenCalledTimes(1);
});

test.each([541, 429])(
  '查询参数详情接口 %s 保留官网拒绝错误，不被后续导航失败覆盖',
  async status => {
    const h = harness();
    const result = h.start();
    const assertion = expect(result).rejects.toThrow('APPLE_THROTTLED');
    await tick();
    h.session.emit('Network.responseReceived', {
      type: 'Fetch',
      requestId: 'detail',
      response: {
        status,
        mimeType: 'application/json',
        url: 'https://secure8.www.apple.com.cn/shop/order/lookup?_a=fetchOrder&_m=guestOrderSpinner',
      },
    });
    h.session.emit('Network.loadingFailed', { type: 'Document', requestId: 'navigation' });
    await assertion;
    expect(h.context.close).toHaveBeenCalledTimes(1);
  }
);

test.each([false, true])('查询参数详情成功回传，详情先于主文档=%s', async detailFirst => {
  const h = harness();
  const body = JSON.stringify(buildLifecycleJson('PROCESSING'));
  h.session.send.mockImplementation((method, params) =>
    Promise.resolve(
      method === 'Network.getResponseBody'
        ? { body: params.requestId === 'detail' ? body : '<html>加载订单</html>' }
        : {}
    )
  );
  const result = h.start();
  await tick();
  const detail = () => {
    h.session.emit('Network.responseReceived', {
      type: 'Fetch',
      requestId: 'detail',
      response: {
        status: 200,
        mimeType: 'application/json',
        url: 'https://secure8.www.apple.com.cn/shop/order/lookup?_a=fetchOrder&_m=guestOrderSpinner',
      },
    });
    h.session.emit('Network.loadingFinished', {
      requestId: 'detail',
      encodedDataLength: body.length,
    });
  };
  if (detailFirst) detail();
  else h.response();
  await tick();
  if (detailFirst) h.response();
  else detail();
  const page = await result;
  expect(page.orderJson.orderDetail.orderHeader.d.orderNumber).toBe(task.orderNumber);
  expect(page.pageUrl).toMatch(/\/redacted$/);
  expect(h.context.close).toHaveBeenCalledTimes(1);
});

test.each(['Target.attachedToTarget', 'popup'])('不支持的子目标 %s 失败关闭', async event => {
  const h = harness();
  const result = h.start();
  const assertion = expect(result).rejects.toThrow('UNSUPPORTED_CHILD_TARGET');
  await tick();
  if (event === 'popup') h.context.emit('page', {});
  else h.session.emit(event, {});
  await assertion;
  expect(h.context.close).toHaveBeenCalledTimes(1);
});

test('超出一百请求即终止，未获许可的请求不会继续', async () => {
  const h = harness();
  const result = h.start();
  const assertion = expect(result).rejects.toThrow('REQUEST_LIMIT');
  await tick();
  for (let i = 0; i < 101; i++)
    h.session.emit('Fetch.requestPaused', {
      requestId: String(i),
      resourceType: 'Document',
    });
  await assertion;
  expect(h.permit).toHaveBeenCalledTimes(100);
  expect(
    h.session.send.mock.calls.filter(([method]) => method === 'Fetch.continueRequest')
  ).toHaveLength(0);
});

test('许可证拒绝不会发送官网请求', async () => {
  const h = harness();
  h.permit.mockRejectedValue(batchError('REFRESH_PAUSED'));
  const result = h.start();
  const assertion = expect(result).rejects.toThrow('REFRESH_PAUSED');
  await tick();
  h.session.emit('Fetch.requestPaused', { requestId: 'one', resourceType: 'Document' });
  await assertion;
  expect(h.session.send.mock.calls.some(([method]) => method === 'Fetch.continueRequest')).toBe(
    false
  );
});

test('取消发生于上下文创建期间，迟到上下文关闭且不导航', async () => {
  const h = harness();
  let create;
  h.browser.newContext.mockImplementation(
    () =>
      new Promise(resolve => {
        create = resolve;
      })
  );
  const controller = new AbortController();
  const result = h.start({ signal: controller.signal });
  const assertion = expect(result).rejects.toThrow('CANCELLED');
  controller.abort();
  await assertion;
  create(h.context);
  await tick();
  expect(h.context.close).toHaveBeenCalledTimes(1);
  expect(h.context.newPage).not.toHaveBeenCalled();
});

test.each(['wrong-url', 'wrong-json', 'oversized', 'invalid-json'])(
  '拒绝异常数据 %s',
  async mode => {
    const json = buildLifecycleJson('PROCESSING');
    if (mode === 'wrong-json') json.orderDetail.orderHeader.d.orderNumber = 'W9999999999';
    const h = harness(
      mode === 'oversized'
        ? 'x'.repeat(2 * 1024 * 1024 + 1)
        : mode === 'invalid-json'
          ? '{broken'
          : JSON.stringify(json)
    );
    const result = h.start();
    const assertion = expect(result).rejects.toThrow('COLLECTION_INVALID');
    await tick();
    h.response(200, mode === 'wrong-url' ? 'W9999999999' : task.orderNumber);
    await assertion;
  }
);

test('加载页无 JSON 到期为待核对，而非生成虚构 JSON', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  try {
    const h = harness('<html>正在加载订单</html>');
    const result = h.start();
    const assertion = expect(result).rejects.toThrow('NO_STRUCTURED_DATA');
    await tick();
    h.response();
    await tick();
    jest.advanceTimersByTime(300001);
    await assertion;
  } finally {
    jest.useRealTimers();
  }
});

test('没有详情页面的超时可重试，非法旧版票据拒绝启动', async () => {
  const h = harness();
  task.maxDurationMs = undefined;
  await expect(h.start()).rejects.toThrow('INVALID_BATCH_TICKET');
  expect(h.browser.newContext).not.toHaveBeenCalled();
  task.maxDurationMs = 300000;
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  try {
    const result = h.start();
    const assertion = expect(result).rejects.toThrow('COLLECTION_TIMEOUT');
    await tick();
    jest.advanceTimersByTime(300001);
    await assertion;
  } finally {
    jest.useRealTimers();
  }
});
