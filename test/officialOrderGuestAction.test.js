/* global window, document */
/* eslint-disable no-magic-numbers -- 合成订单、状态和定时边界。 */
const {
  GUEST_ACTION_BUNDLE,
  GUEST_ACTION_INTEGRITY,
  isGuestActionDocument,
  buildGuestActionRequest,
  installGuestActionReadiness,
  dispatchGuestActionInPage,
} = require('../src/services/officialOrderGuestAction');

const ORDER = 'W0000000001';
const URL = `https://secure6.www.apple.com.cn/shop/orderx/guestx/${ORDER}/synthetic?_a=fetchOrder&_m=guestOrderSpinner`;
const META = {
  status: 200,
  type: 'Document',
  cached: false,
  host: 'secure6.www.apple.com.cn',
  path: '/shop/order/guest/[ORDER]/[TOKEN]',
};
const HEADERS = {
  'x-aos-model-page': 'synthetic-page',
  modelVersion: 'v0',
  'x-aos-stk': 'synthetic-sensitive-token',
  syntax: 'synthetic',
};
function model() {
  return {
    meta: { h: { ...HEADERS } },
    guestOrderSpinner: {
      a: { fetchOrder: { url: URL } },
      b: { fetchOrder: { events: [{ on: 'click', do: 'a.fetchOrder' }] } },
    },
  };
}
function html(value = model(), trace = true, bundle = GUEST_ACTION_BUNDLE) {
  const config = JSON.stringify({ fetchHeaders: { sendHeaders: trace } });
  return (
    `<script id="init_data" type="application/json">${JSON.stringify(value)}</script>` +
    `<script id="uiConfig" type="application/json">${config}</script>` +
    `<script integrity="${GUEST_ACTION_INTEGRITY}" src="${bundle}"></script>`
  );
}

test.each([true, false])('按当前模型构造 POST／空正文，追踪头开关 %s', trace => {
  const result = buildGuestActionRequest(html(model(), trace), META, ORDER);
  expect(result).toMatchObject({
    url: URL,
    method: 'POST',
    body: null,
    credentials: 'include',
    dynamicHeaders: HEADERS,
  });
  expect(result.headers).toMatchObject({
    ...HEADERS,
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'Fetch',
  });
  expect(Boolean(result.headers['x-aos-ui-fetch-call-1'])).toBe(trace);
});
test.each([
  { cached: true },
  { status: 541 },
  { type: 'Script' },
  { host: 'example.test' },
  { path: '/shop/order/list' },
  { cached: undefined },
])('普通、旧或不成功响应不能生成请求 %j', changed => {
  const meta = { ...META, ...changed };
  expect(isGuestActionDocument(meta)).toBe(false);
  expect(buildGuestActionRequest(html(), meta, ORDER)).toBeNull();
});
test.each([
  value => {
    value.guestOrderSpinner.a.fetchOrder.submit = true;
  },
  value => {
    value.guestOrderSpinner.b.fetchOrder.events[0].do = 'a.cancelOrder';
  },
  value => {
    value.guestOrderSpinner.b.fetchOrder.events.push({ on: 'click', do: 'a.fetchOrder' });
  },
  value => {
    value.guestOrderSpinner.a.fetchOrder.target = '_top';
  },
])('拒绝表单、其他绑定和额外动作属性', change => {
  const value = model();
  change(value);
  expect(() => buildGuestActionRequest(html(value), META, ORDER)).toThrow(
    'GUEST_ACTION_MODEL_INVALID'
  );
});
test.each([
  URL.replace(ORDER, 'W0000000002'),
  URL.replace('secure6.www.apple.com.cn', 'www.apple.com.cn'),
  URL.replace('fetchOrder', 'cancelOrder'),
  URL + '&_a=fetchOrder',
  URL + '#fragment',
])('拒绝其他身份、源或动作 %s', url => {
  const value = model();
  value.guestOrderSpinner.a.fetchOrder.url = url;
  expect(() => buildGuestActionRequest(html(value), META, ORDER)).toThrow(
    'GUEST_ACTION_IDENTITY_MISMATCH'
  );
});
test.each([
  null,
  [],
  {},
  { ...HEADERS, Cookie: 'not-allowed' },
  { ...HEADERS, syntax: '' },
  { ...HEADERS, syntax: 1 },
  { ...HEADERS, syntax: 'a\r\nb' },
  { ...HEADERS, syntax: 'x'.repeat(1025) },
])('缺失、未知或无效动态头不能发送 %j', headers => {
  const value = model();
  value.meta.h = headers;
  expect(() => buildGuestActionRequest(html(value), META, ORDER)).toThrow(
    'GUEST_ACTION_HEADERS_INVALID'
  );
});
test('拒绝脚本变版、SRI、缺失模型和过大文档', () => {
  expect(() =>
    buildGuestActionRequest(
      html(model(), true, GUEST_ACTION_BUNDLE.replace('5.18.5', '5.18.6')),
      META,
      ORDER
    )
  ).toThrow('GUEST_ACTION_SCRIPT_VERSION_UNSUPPORTED');
  expect(() =>
    buildGuestActionRequest(html().replace(GUEST_ACTION_INTEGRITY, 'sha256-test'), META, ORDER)
  ).toThrow('GUEST_ACTION_SCRIPT_VERSION_UNSUPPORTED');
  expect(() => buildGuestActionRequest('<html></html>', META, ORDER)).toThrow(
    'GUEST_ACTION_MODEL_INVALID'
  );
  expect(() => buildGuestActionRequest('x'.repeat(2097153), META, ORDER)).toThrow(
    'GUEST_ACTION_DOCUMENT_INVALID'
  );
});

let listeners;
let request;
let options;
beforeEach(() => {
  jest.useFakeTimers();
  listeners = {};
  global.document = {
    readyState: 'complete',
    addEventListener: jest.fn(),
    querySelector: () => ({ textContent: JSON.stringify(model()) }),
    querySelectorAll: () => [
      { getAttribute: name => (name === 'src' ? GUEST_ACTION_BUNDLE : GUEST_ACTION_INTEGRITY) },
    ],
  };
  global.window = {
    document,
    shldConfig: { isEnabled: true },
    location: { origin: 'https://secure6.www.apple.com.cn' },
    addEventListener: (event, callback) => {
      listeners[event] = callback;
    },
    fetch: jest.fn().mockResolvedValue({
      status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
    }),
  };
  request = buildGuestActionRequest(html(), META, ORDER);
  options = { key: 'synthetic', request, readyTimeoutMs: 500, pollMs: 25, requestTimeoutMs: 1000 };
});
afterEach(() => {
  delete global.window;
  delete global.document;
  jest.useRealTimers();
});

test('仅自然就绪且原 bundle 已取消后派发一次，重复调用拒绝', async () => {
  installGuestActionReadiness({ key: 'synthetic', settleMs: 50 });
  options.scriptBlocked = true;
  listeners.shldDone({ detail: { id: 'synthetic-ready' } });
  const result = dispatchGuestActionInPage(options);
  expect(window.fetch).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(75);
  expect(await result).toEqual({ outcome: 'GUEST_ACTION_RESPONSE', status: 200 });
  expect(window.fetch).toHaveBeenCalledTimes(1);
  expect(window.fetch.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    credentials: 'include',
    body: null,
  });
  expect(await dispatchGuestActionInPage(options)).toEqual({
    outcome: 'GUEST_ACTION_ALREADY_SENT',
  });
});
test('未就绪或 shld-no-ck 不会触发请求', async () => {
  installGuestActionReadiness({ key: 'synthetic', settleMs: 0 });
  options.scriptBlocked = true;
  listeners.shldDone({ detail: { id: 'shld-no-ck' } });
  const result = dispatchGuestActionInPage(options);
  await jest.advanceTimersByTimeAsync(550);
  expect(await result).toEqual({
    outcome: 'GUEST_ACTION_READINESS_TIMEOUT',
    readiness: {
      available: true,
      waitedMs: 500,
      documentState: 'complete',
      visibility: 'unknown',
      hasFocus: null,
      configPresent: true,
      configEnabled: true,
      readyObserved: false,
      settlePending: false,
      readySource: null,
      acceptedSignals: 0,
      ignoredSignals: 1,
    },
  });
  expect(window.fetch).not.toHaveBeenCalled();
});

test.each([undefined, {}, { isEnabled: 'false' }])(
  '配置缺失或不明确关闭时仍等待自然信号：%j',
  config => {
    window.shldConfig = config;
    installGuestActionReadiness({ key: 'synthetic', settleMs: 0 });
    options.scriptBlocked = true;
    const result = dispatchGuestActionInPage(options);
    return jest.advanceTimersByTimeAsync(550).then(async () => {
      expect(await result).toMatchObject({
        outcome: 'GUEST_ACTION_READINESS_TIMEOUT',
        readiness: {
          available: true,
          configPresent: !!config,
          configEnabled: null,
          readyObserved: false,
        },
      });
      expect(window.fetch).not.toHaveBeenCalled();
    });
  }
);
test.each(['loading', 'settling', 'late-disabled'])(
  '只读诊断区分自然就绪等待阶段，不改变原门槛：%s',
  async phase => {
    document.visibilityState = 'hidden';
    document.hasFocus = () => false;
    installGuestActionReadiness({ key: 'synthetic', settleMs: phase === 'settling' ? 1000 : 0 });
    options.scriptBlocked = true;
    if (phase !== 'late-disabled') listeners.shldDone({ detail: { id: 'synthetic-ready' } });
    if (phase === 'loading') document.readyState = 'loading';
    if (phase === 'late-disabled') window.shldConfig.isEnabled = false;
    const pending = dispatchGuestActionInPage(options);
    await jest.advanceTimersByTimeAsync(550);
    expect(await pending).toMatchObject({
      outcome: 'GUEST_ACTION_READINESS_TIMEOUT',
      readiness: {
        available: true,
        documentState: phase === 'loading' ? 'loading' : 'complete',
        visibility: 'hidden',
        hasFocus: false,
        configEnabled: phase !== 'late-disabled',
        readyObserved: phase !== 'late-disabled',
        settlePending: phase === 'settling',
        acceptedSignals: phase === 'late-disabled' ? 0 : 1,
        readySource: phase === 'late-disabled' ? null : 'native_event',
      },
    });
    expect(window.fetch).not.toHaveBeenCalled();
  }
);
test('诊断只输出规定枚举和计数，不透出事件、配置或被修改的状态内容', async () => {
  const secret = 'synthetic-cookie-or-token';
  installGuestActionReadiness({ key: 'synthetic', settleMs: 0 });
  options.scriptBlocked = true;
  window.synthetic.acceptedSignals = secret;
  window.synthetic.ignoredSignals = { secret };
  window.synthetic.readySource = secret;
  window.shldConfig = { isEnabled: secret, secret };
  document.readyState = secret;
  document.visibilityState = secret;
  const pending = dispatchGuestActionInPage(options);
  await jest.advanceTimersByTimeAsync(550);
  const result = await pending;
  expect(result).toMatchObject({
    outcome: 'GUEST_ACTION_READINESS_TIMEOUT',
    readiness: {
      available: true,
      documentState: 'unknown',
      visibility: 'unknown',
      configEnabled: null,
      acceptedSignals: null,
      ignoredSignals: null,
      readySource: null,
    },
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(window.fetch).not.toHaveBeenCalled();
});
test('诊断自身失败不替换原超时，也不重试网络', async () => {
  installGuestActionReadiness({ key: 'synthetic', settleMs: 0 });
  options.scriptBlocked = true;
  document.hasFocus = () => {
    throw new Error('synthetic diagnostic error');
  };
  const pending = dispatchGuestActionInPage(options);
  await jest.advanceTimersByTimeAsync(550);
  expect(await pending).toEqual({
    outcome: 'GUEST_ACTION_READINESS_TIMEOUT',
    readiness: { available: false },
  });
  expect(window.fetch).not.toHaveBeenCalled();
});
test.each(['origin', 'url', 'headers', 'document'])(
  '就绪后再次核对当前页面，拒绝变化 %s',
  field => {
    window.shldConfig.isEnabled = false;
    installGuestActionReadiness({ key: 'synthetic', settleMs: 0 });
    options.scriptBlocked = true;
    if (field === 'origin') window.location.origin = 'https://example.test';
    if (field === 'url') request.url += '&changed=1';
    if (field === 'headers') request.dynamicHeaders.syntax = 'changed';
    if (field === 'document') window.synthetic.document = {};
    return expect(dispatchGuestActionInPage(options)).resolves.toEqual({
      outcome: 'GUEST_ACTION_CONTEXT_CHANGED',
    });
  }
);
test('没有观察器或未取消 bundle 不能执行动作', async () => {
  expect(await dispatchGuestActionInPage(options)).toEqual({
    outcome: 'GUEST_ACTION_CONTEXT_CHANGED',
  });
  window.shldConfig.isEnabled = false;
  installGuestActionReadiness({ key: 'synthetic', settleMs: 0 });
  expect(await dispatchGuestActionInPage(options)).toEqual({
    outcome: 'GUEST_ACTION_SCRIPT_NOT_BLOCKED',
  });
});
test('请求失败与非 200 保留结果，不自动重试', async () => {
  window.shldConfig.isEnabled = false;
  installGuestActionReadiness({ key: 'synthetic', settleMs: 0 });
  options.scriptBlocked = true;
  window.fetch.mockRejectedValueOnce(new Error('synthetic'));
  expect(await dispatchGuestActionInPage(options)).toEqual({
    outcome: 'GUEST_ACTION_REQUEST_FAILED',
  });
  expect(window.fetch).toHaveBeenCalledTimes(1);
  expect(await dispatchGuestActionInPage(options)).toEqual({
    outcome: 'GUEST_ACTION_ALREADY_SENT',
  });
});
