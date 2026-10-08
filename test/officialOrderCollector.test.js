/* eslint-disable no-magic-numbers -- 测试使用显式的协议状态和请求编号。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
jest.mock('pg', () => ({ Client: jest.fn(() => ({ query: jest.fn(), end: jest.fn() })) }));
jest.mock('playwright-core', () => ({ chromium: {} }));
jest.mock('../src/services/officialOrderHttpBootstrap', () => ({
  bootstrapOfficialOrderHttp: jest.fn(),
}));
jest.mock('../src/services/officialOrderHttpTransport', () => ({
  OfficialOrderHttpTransport: jest.fn(options => ({
    ...options,
    start: jest.fn(),
    close: jest.fn(),
  })),
}));
const { bootstrapOfficialOrderHttp } = require('../src/services/officialOrderHttpBootstrap');
const { OfficialOrderHttpTransport } = require('../src/services/officialOrderHttpTransport');
const OfficialOrderCollector = require('../src/services/officialOrderCollector');
const { writePrivate, hash, decrypt, encrypt } = require('../src/services/officialOrderSupport');
const { validateSample } = require('../src/services/officialOrderSupport');

let directory;
let collector;
const ORDER = 'W1234567890';
const RESPONSE = {
  requestId: 'r1',
  type: 'XHR',
  response: {
    url: `https://secure6.www.apple.com.cn/shop/orderx/guestx/${ORDER}/${'a'.repeat(80)}?_a=fetchOrder`,
    status: 200,
    headers: {},
  },
};
function detail() {
  return JSON.stringify({
    orderDetail: {
      orderHeader: { d: { orderNumber: ORDER } },
      orderItems: {
        c: ['orderItem-11'],
        'orderItem-11': {
          orderItemDetails: { d: { productName: '测试商品 512GB 蓝色', quantity: 2 } },
          orderItemStatusTracker: { d: { currentStatus: 'PICKED_UP' } },
        },
      },
    },
  });
}
function event(method, params, sessionId = 's1') {
  return { method, params, sessionId };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'official-collector-'));
  writePrivate(
    `${directory}/private/db.json`,
    JSON.stringify({ host: 'apple-account-research-db', database: 'apple_account_research' })
  );
  writePrivate(`${directory}/private/evidence.key`, crypto.randomBytes(32));
  writePrivate(
    `${directory}/private/fan-1.json`,
    JSON.stringify({
      host: 'proxy.example.test',
      port: 8080,
      username: 'fake-user',
      password: 'fake-password',
    })
  );
  writePrivate(
    `${directory}/private/request.json`,
    JSON.stringify({
      samples: [
        {
          id: 11,
          orderNumber: ORDER,
          email: 'account@example.test',
          password: 'test-only',
          url: `https://www.apple.com.cn/shop/order/list/${ORDER}/contact%40example.test`,
        },
      ],
    })
  );
  collector = new OfficialOrderCollector({
    root: directory,
    inputFile: `${directory}/private/request.json`,
    orderId: 11,
    proxyFile: `${directory}/private/fan-1.json`,
  });
  collector.directory = `${directory}/evidence/run-1`;
  fs.mkdirSync(collector.directory, { recursive: true });
  collector.logger = { info: jest.fn() };
  collector.sessions.add('s1');
  collector.cdp = { send: jest.fn().mockResolvedValue({ body: detail(), base64Encoded: false }) };
  collector.gate.permit = jest.fn().mockResolvedValue({ index: 1, urlHash: 'hash' });
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

test('IPRoyal 密码摘要和长租期与提供配置一致，旧供应商不能冒用长租期', () => {
  const { proxyFingerprint } = require('../src/services/officialOrderSupport');
  const proxy = {
    host: 'geo.iproyal.com',
    port: 12321,
    username: 'test',
    password: 'synthetic',
    provider: 'iproyal',
  };
  writePrivate(`${directory}/private/iproyal.json`, JSON.stringify(proxy));
  const options = {
    root: directory,
    inputFile: `${directory}/private/request.json`,
    orderId: 11,
    proxyFile: `${directory}/private/iproyal.json`,
    captureReceipt: true,
    leaseContext: {
      provider: 'iproyal',
      proxyHash: proxyFingerprint(proxy),
      egressHash: 'a'.repeat(64),
      startedAt: new Date(Date.now() - 700000).toISOString(),
    },
  };
  expect(new OfficialOrderCollector(options).proxyHash).toBe(proxyFingerprint(proxy));
  expect(
    () =>
      new OfficialOrderCollector({
        ...options,
        leaseContext: { ...options.leaseContext, provider: 'fanproxy' },
      })
  ).toThrow('PROXY_LEASE_INVALID');
});

test('会话保存保留认证起点，复用不会刷新 105 分钟期限', async () => {
  expect(collector.persistSessions).toBe(true);
  const began = Date.now() - 120000;
  collector.context = { storageState: jest.fn().mockResolvedValue({ cookies: [] }) };
  collector.seal = jest.fn();
  collector.passwordSubmitted = true;
  collector.passwordSubmittedAt = began;
  await collector.saveSession();
  const state = JSON.parse(decrypt(fs.readFileSync(collector.sessionFile), collector.key));
  expect(state.createdAt).toBe(new Date(began).toISOString());
  collector.passwordSubmitted = false;
  collector.sessionCreatedAt = state.createdAt;
  await collector.saveSession();
  expect(JSON.parse(decrypt(fs.readFileSync(collector.sessionFile), collector.key)).createdAt).toBe(
    state.createdAt
  );
});

test('恢复官方同源存储，过期或跨出口会话不注入', async () => {
  const origins = [
    {
      origin: 'https://www.apple.com.cn',
      localStorage: [{ name: 'test-key', value: 'test-value' }],
    },
  ];
  writePrivate(
    collector.sessionFile,
    encrypt(
      {
        accountHash: collector.sample.accountHash,
        createdAt: new Date().toISOString(),
        cookies: [],
        origins,
      },
      collector.key
    )
  );
  collector.context = { setStorageState: jest.fn(), addCookies: jest.fn() };
  await collector.restoreSession();
  expect(collector.context.setStorageState).toHaveBeenCalledWith({ cookies: [], origins });
  collector.leaseContext = { egressHash: 'new' };
  collector.context.setStorageState.mockClear();
  await collector.restoreSession();
  expect(collector.context.setStorageState).not.toHaveBeenCalled();
});

test.each([502, 503, 504])('登录暂时故障 %i 不误判为密码拒绝', async status => {
  await collector.event(
    event('Network.responseReceived', {
      ...RESPONSE,
      response: {
        ...RESPONSE.response,
        url: 'https://idmsa.apple.com.cn/appleauth/auth/signin/complete',
        status,
      },
    })
  );
  expect(collector.stopped).toBe(`HTTP_${status}`);
});

test.each(['Image', 'Font', 'Script'])(
  '完整 Chromium 的官方 %s 经过全局许可正常加载',
  async resourceType => {
    collector.captureReceipt = true;
    collector.browserMode = 'chromium';
    await collector.event(
      event('Fetch.requestPaused', {
        requestId: 'native-resource',
        resourceType,
        request: { url: 'https://www.apple.com.cn/asset' },
      })
    );
    expect(collector.gate.permit).toHaveBeenCalledTimes(1);
    expect(collector.cdp.send).toHaveBeenCalledWith(
      'Fetch.continueRequest',
      { requestId: 'native-resource' },
      's1'
    );
  }
);

test('轻量浏览器只选择相同版本的现有二进制，缺失时明确停止', () => {
  const { chromium } = require('playwright-core');
  chromium.executablePath = jest.fn(() => '/ms-playwright/chromium-1243/chrome-linux64/chrome');
  expect(collector.browserExecutable()).toBe(chromium.executablePath());
  collector.browserMode = 'headless-shell';
  const exists = jest.spyOn(fs, 'existsSync');
  try {
    exists.mockReturnValue(true);
    expect(collector.browserExecutable()).toBe(
      '/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'
    );
    exists.mockReturnValue(false);
    expect(() => collector.browserExecutable()).toThrow('BROWSER_EXECUTABLE_UNAVAILABLE');
  } finally {
    exists.mockRestore();
  }
});

test('连接回收按在途请求跟踪主机，重定向和失败释放原主机', async () => {
  await collector.event(
    event('Network.requestWillBeSent', {
      requestId: 'tracked',
      request: { url: 'https://www.apple.com.cn/shop/' },
    })
  );
  expect([...collector.inFlightHosts.values()]).toEqual(['www.apple.com.cn']);
  await collector.event(
    event('Network.requestWillBeSent', {
      requestId: 'tracked',
      request: { url: 'https://idmsa.apple.com.cn/auth/' },
    })
  );
  expect([...collector.inFlightHosts.values()]).toEqual(['idmsa.apple.com.cn']);
  await collector.event(event('Network.loadingFailed', { requestId: 'tracked', canceled: true }));
  expect(collector.inFlightHosts.size).toBe(0);
});

test.each(['Image', 'Font'])('补录禁用非必要 %s，不消耗官网请求许可', async resourceType => {
  collector.captureReceipt = true;
  await collector.event(
    event('Fetch.requestPaused', {
      requestId: 'asset',
      resourceType,
      request: { url: 'https://www.apple.com.cn/asset' },
    })
  );
  expect(collector.gate.permit).not.toHaveBeenCalled();
  expect(collector.cdp.send).toHaveBeenCalledWith(
    'Fetch.failRequest',
    {
      requestId: 'asset',
      errorReason: 'Aborted',
    },
    's1'
  );
  expect(collector.stopped).toBe(null);
});

test('完成与目标断开不遗留连接占用，其他目标请求仍保留', async () => {
  collector.sessions.add('s2');
  for (const session of ['s1', 's2']) {
    await collector.event(
      event(
        'Network.requestWillBeSent',
        {
          requestId: 'tracked',
          request: { url: 'https://www.apple.com.cn/shop/' },
        },
        session
      )
    );
  }
  await collector.event(event('Network.loadingFinished', { requestId: 'tracked' }));
  expect(collector.inFlightHosts.size).toBe(1);
  await collector.event(event('Target.detachedFromTarget', { sessionId: 's2' }));
  expect(collector.inFlightHosts.size).toBe(0);
});

test('父页面 Fetch 拦截先就绪，再释放脚本；Worker 由父页面接管', async () => {
  await collector.attach('s2', { targetId: 't2', type: 'page' });
  const calls = collector.cdp.send.mock.calls.map(args => args[0]);
  expect(calls.indexOf('Fetch.enable')).toBeLessThan(
    calls.indexOf('Runtime.runIfWaitingForDebugger')
  );
  expect(collector.readyTargets.has('t2')).toBe(true);
  collector.cdp.send.mockClear();
  await collector.attach('s3', { targetId: 't3', type: 'worker' });
  expect(collector.cdp.send.mock.calls.map(args => args[0])).toEqual([
    'Network.enable',
    'Runtime.runIfWaitingForDebugger',
  ]);
});
test('子请求每次经过许可；非官方重定向直接失败，不退回已用许可', async () => {
  await collector.event(
    event('Fetch.requestPaused', {
      requestId: 'f1',
      resourceType: 'Document',
      request: { url: 'https://www.apple.com.cn/' },
    })
  );
  expect(collector.gate.permit).toHaveBeenCalledTimes(1);
  expect(collector.cdp.send).toHaveBeenCalledWith(
    'Fetch.continueRequest',
    { requestId: 'f1' },
    's1'
  );
  await collector.event(
    event('Fetch.requestPaused', {
      requestId: 'f2',
      resourceType: 'Document',
      request: { url: 'https://evil.test/' },
    })
  );
  expect(collector.gate.permit).toHaveBeenCalledTimes(1);
  expect(collector.cdp.send).toHaveBeenCalledWith(
    'Fetch.failRequest',
    { requestId: 'f2', errorReason: 'Aborted' },
    's1'
  );
  expect(collector.stopped).toBeNull();
});
test('导航取消不终止采集，其他 CDP 失败终止并保存加密诊断', async () => {
  collector.cdp.send.mockRejectedValueOnce(
    Object.assign(new Error('canceled'), {
      method: 'Fetch.continueRequest',
      detail: 'Invalid InterceptionId.',
    })
  );
  const paused = event('Fetch.requestPaused', {
    requestId: 'f1',
    resourceType: 'Script',
    request: { url: 'https://www.apple.com.cn/test.js' },
  });
  await collector.event(paused);
  expect(collector.stopped).toBeNull();
  collector.cdp.send.mockRejectedValueOnce(
    Object.assign(new Error('protocol'), {
      code: 'CDP_COMMAND_FAILED',
      method: 'Fetch.continueRequest',
      detail: 'Unknown method',
    })
  );
  await collector.event(paused);
  expect(collector.stopped).toBe('CDP_COMMAND_FAILED');
  expect(fs.readdirSync(collector.directory).some(name => name.startsWith('runtime-error-'))).toBe(
    true
  );
});
test('代理凭据仅回应一次 Proxy 挑战，不发送给网页服务器', async () => {
  const challenge = event('Fetch.authRequired', {
    requestId: 'auth1',
    authChallenge: { source: 'Proxy' },
  });
  await collector.event(challenge);
  expect(collector.cdp.send.mock.calls[0][1].authChallengeResponse.response).toBe(
    'ProvideCredentials'
  );
  await collector.event(challenge);
  expect(collector.cdp.send.mock.calls[1][1].authChallengeResponse.response).toBe('CancelAuth');
  expect(collector.stopped).toBe('HTTP_AUTH_FAILED');
  collector.stopped = null;
  await collector.event(
    event('Fetch.authRequired', { requestId: 'auth2', authChallenge: { source: 'Server' } })
  );
  expect(collector.cdp.send.mock.calls[2][1].authChallengeResponse.response).toBe('CancelAuth');
});
test('预先认证模式不再向浏览器挑战提供上游代理凭据', async () => {
  collector.proxy.preemptiveAuth = true;
  await collector.event(
    event('Fetch.authRequired', { requestId: 'auth1', authChallenge: { source: 'Proxy' } })
  );
  expect(collector.cdp.send.mock.calls[0][1].authChallengeResponse).toEqual({
    response: 'CancelAuth',
  });
  expect(collector.stopped).toBe('HTTP_AUTH_FAILED');
});
test('只将新鲜完整、身份匹配的 guestx 响应认定成功；证据密文可独立校验', async () => {
  await collector.event(event('Network.responseReceived', RESPONSE));
  await collector.event(
    event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 1000 })
  );
  expect(collector.stopped).toBe('SUCCEEDED');
  expect(collector.result).toMatchObject({
    orderNumber: ORDER,
    products: [{ name: '测试商品 512GB 蓝色', quantity: 2, rawStatus: 'PICKED_UP' }],
  });
  const evidence = fs.readFileSync(`${collector.directory}/${collector.resultEvidence.file}`);
  expect(hash(decrypt(evidence, collector.key))).toBe(collector.resultEvidence.sha256);
  expect(collector.resultEvidence.path).toBe('/shop/orderx/guestx/[ORDER]/[TOKEN]');
  expect(JSON.stringify(collector.logger.info.mock.calls)).not.toContain('a'.repeat(80));
});
test.each(['cached', 'loading', 'identity', 'failed-before'])(
  '缓存、加载页、其他订单和已有失败不算本次成功：%s',
  async kind => {
    const response = JSON.parse(JSON.stringify(RESPONSE));
    if (kind === 'cached') response.response.fromDiskCache = true;
    if (kind === 'loading') collector.cdp.send.mockResolvedValue({ body: '<html>loading</html>' });
    if (kind === 'identity')
      collector.cdp.send.mockResolvedValue({ body: detail().replace(ORDER, 'W9999999999') });
    if (kind === 'failed-before') collector.stopped = 'HTTP_541';
    await collector.event(event('Network.responseReceived', response));
    const finished = collector.event(
      event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 1000 })
    );
    if (kind === 'identity') await expect(finished).rejects.toThrow('IDENTITY_MISMATCH');
    else await finished;
    expect(collector.result).toBeUndefined();
  }
);
test.each([407, 429, 541])('风险响应 %i 停止并保留 Retry-After', async status => {
  await collector.event(
    event('Network.responseReceived', {
      ...RESPONSE,
      response: { ...RESPONSE.response, status, headers: { 'Retry-After': '7200' } },
    })
  );
  expect(collector.stopped).toBe(`HTTP_${status}`);
  expect(collector.retryAfter).toBe('7200');
});
test('密码失败和人工验证明确结束；不继续尝试密码', async () => {
  const response = {
    ...RESPONSE,
    response: {
      ...RESPONSE.response,
      url: 'https://idmsa.apple.com.cn/appleauth/auth/signin/complete',
      status: 401,
    },
  };
  await collector.event(event('Network.responseReceived', response));
  expect(collector.stopped).toBe('AUTH_REJECTED');
  collector.stopped = null;
  await collector.event(
    event('Network.responseReceived', {
      ...response,
      response: { ...response.response, status: 409 },
    })
  );
  expect(collector.stopped).toBe('HUMAN_VERIFICATION_REQUIRED');
});
test('超过正文上限和代理故障保留失败，不制造空订单成功', async () => {
  await collector.event(event('Network.responseReceived', RESPONSE));
  await collector.event(
    event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 8388609 })
  );
  expect(collector.stopped).toBe('BODY_TOO_LARGE');
  collector.stopped = null;
  await collector.event(
    event('Network.loadingFailed', {
      requestId: 'r1',
      type: 'Document',
      errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED',
    })
  );
  expect(collector.stopped).toBe('PROXY_CONNECTION_FAILED');
});
test('412 单独分类、密封 Location，立即阻断新 GET/POST 和登录操作', async () => {
  const location = 'https://appleid.apple.com/account/manage/repair?token=private-token';
  await collector.event(
    event('Network.responseReceived', {
      ...RESPONSE,
      response: {
        url: 'https://idmsa.apple.com.cn/appleauth/auth/signin/complete',
        status: 412,
        headers: { Location: location },
      },
    })
  );
  expect(collector.stopped).toBe('AUTH_PRECONDITION_REQUIRED');
  expect(collector.authDiagnostic).toEqual({ status: 412, hasLocation: true });
  const file = fs.readdirSync(collector.directory).find(name => name.startsWith('auth-response-'));
  expect(
    JSON.parse(decrypt(fs.readFileSync(`${collector.directory}/${file}`), collector.key))
  ).toEqual({ status: 412, location });
  collector.page = { frames: jest.fn() };
  collector.navigateAccount = jest.fn();
  await collector.loginStep();
  expect(collector.navigateAccount).not.toHaveBeenCalled();
  expect(collector.page.frames).not.toHaveBeenCalled();
  for (const method of ['GET', 'POST']) {
    await collector.event(
      event('Fetch.requestPaused', {
        requestId: method,
        resourceType: 'XHR',
        request: { method, url: location },
      })
    );
  }
  expect(collector.gate.permit).not.toHaveBeenCalled();
  expect(
    collector.cdp.send.mock.calls.filter(call => call[0] === 'Fetch.failRequest')
  ).toHaveLength(2);
  expect(JSON.stringify(collector.logger.info.mock.calls)).not.toContain('private-token');
  collector.cdp.send.mockResolvedValue({ body: '{"authType":"sa","detail":"secret"}' });
  await collector.event(
    event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 40 })
  );
  expect(collector.authDiagnostic.authType).toBe('sa');
  expect(collector.result).toBeUndefined();
  expect(JSON.stringify(collector.logger.info.mock.calls)).not.toContain('secret');
});
test.each(['unrecognized-private-value', null])(
  '诊断正文不向普通日志透传未知 authType：%s',
  async authType => {
    collector.beginAuthDiagnostic({ status: 412, headers: {} });
    collector.requests.set('s1:r1', {
      type: 'XHR',
      path: '/appleauth/auth/signin/complete',
      status: 412,
    });
    collector.cdp.send.mockResolvedValue({ body: JSON.stringify({ authType }) });
    await collector.event(
      event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 50 })
    );
    expect(collector.authDiagnostic.authType).toBeUndefined();
  }
);
test('412 后只读取当前页面，明文加密且页面挂起不会延长诊断', async () => {
  jest.useFakeTimers();
  try {
    collector.beginAuthDiagnostic({ status: 412, headers: {} });
    const frame = {
      url: () => 'https://idmsa.apple.com.cn/appleauth/auth/authorize/signin',
      evaluate: jest.fn().mockResolvedValue('请核对 account@example.test 的账号资料'),
    };
    const hanging = { url: frame.url, evaluate: jest.fn(() => new Promise(() => {})) };
    collector.page = { frames: () => [frame, hanging], goto: jest.fn() };
    const task = collector.captureAuthDiagnostic();
    await jest.advanceTimersByTimeAsync(3001);
    await task;
    expect(collector.authDiagnostic.visibleFrameCount).toBe(1);
    expect(collector.page.goto).not.toHaveBeenCalled();
    expect(collector.gate.permit).not.toHaveBeenCalled();
    const file = fs.readdirSync(collector.directory).find(name => name.startsWith('auth-page-'));
    const captured = JSON.parse(
      decrypt(fs.readFileSync(`${collector.directory}/${file}`), collector.key)
    );
    expect(captured.snapshots[0].text).toContain('account@example.test');
    expect(JSON.stringify(collector.logger.info.mock.calls)).not.toContain('account@example.test');
    expect(collector.stopped).toBe('AUTH_PRECONDITION_REQUIRED');
  } finally {
    jest.useRealTimers();
  }
});
test('412 的诊断读取失败不改变账号失败结果', async () => {
  collector.beginAuthDiagnostic({ status: 412, headers: {} });
  collector.page = {};
  const seal = collector.seal;
  collector.seal = jest.fn(() => {
    throw new Error('disk error');
  });
  await collector.captureAuthDiagnostic();
  expect(collector.stopped).toBe('AUTH_PRECONDITION_REQUIRED');
  collector.seal = seal;
});
test('页面会话断开后不再放行它的请求', async () => {
  await collector.event(event('Target.detachedFromTarget', { sessionId: 's1' }));
  await collector.event(
    event('Fetch.requestPaused', {
      requestId: 'f1',
      resourceType: 'Document',
      request: { url: 'https://www.apple.com.cn/' },
    })
  );
  expect(collector.cdp.send).not.toHaveBeenCalled();
});

test('服务器会话保存及全新实例恢复保持账号与原创建时间，过期进入冷登录', async () => {
  const createdAt = new Date(Date.now() - 60000).toISOString();
  collector.context = {
    storageState: jest.fn().mockResolvedValue({
      cookies: [{ domain: '.apple.com.cn', name: 'synthetic', value: 'test' }],
    }),
    addCookies: jest.fn().mockResolvedValue(),
  };
  collector.sessionCreatedAt = createdAt;
  await collector.saveSession();
  const envelope = JSON.parse(decrypt(fs.readFileSync(collector.sessionFile), collector.key));
  expect(envelope.createdAt).toBe(createdAt);
  expect(envelope.accountHash).toBe(collector.sample.accountHash);
  await collector.restoreSession();
  expect(collector.context.addCookies).toHaveBeenCalledWith(envelope.cookies);
  expect(collector.sessionRestored).toBe(true);
  collector.sessionRestored = false;
  writePrivate(
    collector.sessionFile,
    encrypt(
      { ...envelope, createdAt: new Date(Date.now() - 21600001).toISOString() },
      collector.key
    )
  );
  await collector.restoreSession();
  expect(collector.sessionRestored).toBe(false);
});
test('其他账号的加密会话绝不复用', async () => {
  writePrivate(
    collector.sessionFile,
    encrypt(
      { accountHash: 'another', createdAt: new Date().toISOString(), cookies: [] },
      collector.key
    )
  );
  await expect(collector.restoreSession()).rejects.toThrow('SESSION_IDENTITY_MISMATCH');
});
test('旧研究会话导入同时核对数据库样本和私有账号映射', async () => {
  collector.resumeRun = '12';
  collector.gate.lockClient.query.mockResolvedValue({
    // eslint-disable-next-line camelcase -- PostgreSQL 原始行字段。
    rows: [{ sample_id: 12, started_at: new Date() }],
  });
  writePrivate(
    `${directory}/private/inputs.json`,
    JSON.stringify({ samples: [{ id: 11, accountHash: collector.sample.accountHash }] })
  );
  await expect(collector.restoreSession()).rejects.toThrow('SESSION_IDENTITY_MISMATCH');
  collector.resumeRun = '../../12';
  await expect(collector.restoreSession()).rejects.toThrow('RESUME_RUN_INVALID');
});
test('官网后台 Cookie 尚未出现时等待，不在未知字段或非 IDMS 框架填密码', async () => {
  collector.context = { cookies: jest.fn().mockResolvedValue([]) };
  expect(await collector.waitForSiteReady()).toBe(false);
  collector.context.cookies.mockResolvedValue([
    { name: 'shld_bt_ck', value: `opaque|${Math.floor(Date.now() / 1000) + 600}|opaque` },
  ]);
  expect(await collector.waitForSiteReady()).toBe(true);
  expect(await collector.waitForSiteReady()).toBe(true);
  collector.navigateAccount = jest.fn().mockResolvedValue();
  collector.page = { frames: () => [{ url: () => 'https://example.test/', locator: jest.fn() }] };
  await collector.loginStep();
  expect(collector.passwordSubmitted).toBe(false);
});

test('HTTP登录引导复用既有gate且不提升为已登录会话', async () => {
  collector.httpBootstrap = true;
  collector.httpPythonPath = '/runtime/venv/bin/python';
  collector.leaseContext = { provider: 'iproyal' };
  collector.id = 1;
  collector.context = { addCookies: jest.fn() };
  const cookies = [{ name: 'shld_bt_ck', value: 'private-test-cookie' }];
  bootstrapOfficialOrderHttp.mockResolvedValueOnce({
    cookies,
    loginPageUrl: 'https://secure7.www.apple.com.cn/shop/signIn/account?r=current',
  });
  await collector.prepareHttpLogin();
  const transport = OfficialOrderHttpTransport.mock.results.at(-1).value;
  expect(transport.gate).toBe(collector.gate);
  collector.leaseContext.startedAt = new Date().toISOString();
  expect(transport.isStopped()).toBe(false);
  collector.leaseContext.startedAt = '2020-01-01T00:00:00.000Z';
  expect(() => transport.isStopped()).toThrow('PROXY_LEASE_EXPIRED');
  expect(collector.context.addCookies).toHaveBeenCalledWith(cookies);
  expect(transport.close).toHaveBeenCalledTimes(1);
  expect(collector.sessionRestored).toBeFalsy();
  expect(collector.passwordSubmitted).toBe(false);
  expect(JSON.stringify(collector.logger.info.mock.calls)).not.toContain('private-test-cookie');
});

test('HTTP引导模式不持久或恢复未经认证证明的Cookie包', async () => {
  collector.httpBootstrap = true;
  collector.context = { storageState: jest.fn(), addCookies: jest.fn() };
  writePrivate(
    collector.sessionFile,
    encrypt(
      {
        accountHash: collector.sample.accountHash,
        createdAt: new Date().toISOString(),
        cookies: [],
      },
      collector.key
    )
  );
  const old = fs.readFileSync(collector.sessionFile);
  await collector.restoreSession();
  await collector.saveSession();
  expect(collector.sessionRestored).toBeFalsy();
  expect(collector.context.addCookies).not.toHaveBeenCalled();
  expect(collector.context.storageState).not.toHaveBeenCalled();
  expect(fs.readFileSync(collector.sessionFile)).toEqual(old);
});

test.each([true, false])(
  '禁用磁盘会话时不读取、导入、导出或覆盖会话：httpBootstrap=%s',
  async httpBootstrap => {
    collector.httpBootstrap = httpBootstrap;
    collector.persistSessions = false;
    // 即使显式传入历史 run，也不能访问研究库或旧证据。
    collector.resumeRun = '12';
    collector.context = {
      storageState: jest.fn(),
      setStorageState: jest.fn(),
      addCookies: jest.fn(),
    };
    collector.seal = jest.fn();
    writePrivate(collector.sessionFile, Buffer.from('historical-session-must-remain-unchanged'));
    const old = fs.readFileSync(collector.sessionFile);
    const spies = ['readFileSync', 'writeFileSync', 'readdirSync', 'existsSync'].map(name =>
      jest.spyOn(fs, name)
    );
    try {
      await collector.restoreSession();
      await collector.saveSession();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(collector.gate.lockClient.query).not.toHaveBeenCalled();
    expect(collector.context.storageState).not.toHaveBeenCalled();
    expect(collector.context.setStorageState).not.toHaveBeenCalled();
    expect(collector.context.addCookies).not.toHaveBeenCalled();
    expect(collector.seal).not.toHaveBeenCalled();
    expect(collector.sessionRestored).toBeFalsy();
    expect(fs.readFileSync(collector.sessionFile)).toEqual(old);
  }
);

test.each([null, 'false', 0, {}, []])('磁盘会话配置不是布尔值则失败关闭：%j', persistSessions => {
  expect(() => new OfficialOrderCollector({ root: directory, persistSessions })).toThrow(
    'SESSION_PERSISTENCE_INVALID'
  );
});

test('原生对照模式不启动HTTP传输或导入Cookie，首跳使用既有账户入口', async () => {
  collector.persistSessions = false;
  collector.context = { addCookies: jest.fn(), setStorageState: jest.fn() };
  const transportCount = OfficialOrderHttpTransport.mock.calls.length;
  const bootstrapCount = bootstrapOfficialOrderHttp.mock.calls.length;
  await collector.prepareHttpLogin();
  expect(OfficialOrderHttpTransport.mock.calls.length).toBe(transportCount);
  expect(bootstrapOfficialOrderHttp.mock.calls.length).toBe(bootstrapCount);
  expect(collector.context.addCookies).not.toHaveBeenCalled();
  expect(collector.context.setStorageState).not.toHaveBeenCalled();
  expect(collector.sessionRestored).toBeFalsy();
  expect(collector.bootstrapLoginUrl).toBeUndefined();
  collector.started = Date.now();
  collector.page = { goto: jest.fn().mockResolvedValue() };
  collector.waitForSiteReady = jest.fn(async () => {
    await Promise.resolve();
    collector.stopped = 'SITE_READINESS_TIMEOUT';
    return false;
  });
  collector.loginStep = jest.fn();
  await collector.collectCurrent();
  expect(collector.page.goto).toHaveBeenCalledWith(
    'https://www.apple.com.cn/shop/goto/account',
    expect.objectContaining({ waitUntil: 'domcontentloaded' })
  );
  expect(collector.loginStep).not.toHaveBeenCalled();
  expect(collector.passwordSubmitted).toBe(false);
});

test('HTTP登录引导失败仍关闭传输，有已认证会话则不引导', async () => {
  collector.httpBootstrap = true;
  collector.httpPythonPath = '/runtime/venv/bin/python';
  collector.leaseContext = { provider: 'iproyal' };
  collector.id = 1;
  collector.context = { addCookies: jest.fn() };
  bootstrapOfficialOrderHttp.mockRejectedValueOnce(
    Object.assign(new Error('HTTP_541'), { code: 'HTTP_541', retryAfter: '7200' })
  );
  await expect(collector.prepareHttpLogin()).rejects.toThrow('HTTP_541');
  expect(collector.retryAfter).toBe('7200');
  expect(OfficialOrderHttpTransport.mock.results.at(-1).value.close).toHaveBeenCalledTimes(1);
  expect(collector.context.addCookies).not.toHaveBeenCalled();
  collector.sessionRestored = true;
  const count = OfficialOrderHttpTransport.mock.calls.length;
  await collector.prepareHttpLogin();
  expect(OfficialOrderHttpTransport.mock.calls.length).toBe(count);
});
test('密码仅在 IDMS 可见登录表单提交一次，并先登记持久化冷却', async () => {
  collector.navigateAccount = jest.fn().mockResolvedValue();
  const email = {
    isVisible: jest.fn().mockResolvedValue(true),
    fill: jest.fn().mockResolvedValue(),
  };
  const password = {
    isVisible: jest.fn().mockResolvedValue(true),
    fill: jest.fn().mockResolvedValue(),
  };
  const button = {
    isVisible: jest.fn().mockResolvedValue(true),
    getAttribute: jest.fn().mockResolvedValue('继续'),
    click: jest.fn().mockResolvedValue(),
  };
  collector.gate.claimLogin = jest.fn().mockResolvedValue();
  collector.page = {
    frames: () => [
      {
        url: () => 'https://idmsa.apple.com.cn/appleauth/auth/authorize',
        locator: selector =>
          ({
            '#account_name_text_field': email,
            '#password_text_field': password,
            '#sign-in': button,
          })[selector],
      },
    ],
  };
  await collector.loginStep();
  expect(email.fill).toHaveBeenCalledWith('account@example.test');
  expect(password.fill).not.toHaveBeenCalled();
  button.getAttribute.mockResolvedValue('登录');
  await collector.loginStep();
  await collector.loginStep();
  expect(collector.gate.claimLogin).toHaveBeenCalledTimes(1);
  expect(password.fill).toHaveBeenCalledTimes(1);
  expect(button.click).toHaveBeenCalledTimes(2);
});
test('账号页只导航到官网观察到的登录或订单列表入口', async () => {
  collector.page = {
    url: () => 'https://www.apple.com.cn/shop/account/home',
    locator: () => ({
      evaluateAll: jest
        .fn()
        .mockResolvedValue([
          'https://www.apple.com.cn/shop/signIn',
          'https://www.apple.com.cn/shop/order/list',
        ]),
    }),
    goto: jest.fn().mockResolvedValue(),
  };
  await collector.navigateAccount();
  expect(collector.page.goto.mock.calls[0][0]).toContain('/shop/signIn');
  collector.accountNavigated = false;
  collector.sessionRestored = true;
  await collector.navigateAccount();
  expect(collector.page.goto.mock.calls[1][0]).toContain('/shop/order/list');
});
test.each(['SUCCEEDED', 'HTTP_541', 'IDENTITY_MISMATCH', 'AUTH_PRECONDITION_REQUIRED'])(
  '运行结尾按真实结果分类，失败不覆盖成功数据：%s',
  async outcome => {
    const { EventEmitter } = require('events');
    collector.logger = Object.assign(new EventEmitter(), {
      info: jest.fn(),
      end() {
        this.emit('finish');
      },
    });
    collector.initialize = jest.fn().mockImplementation(() => {
      collector.id = '22';
      collector.started = Date.now();
      return Promise.resolve();
    });
    collector.launch = jest.fn().mockImplementation(() => {
      collector.page = {
        goto: jest.fn().mockImplementation(() => {
          if (outcome === 'IDENTITY_MISMATCH') collector.stopped = 'IDENTITY_MISMATCH';
          else collector.stopped = outcome;
          return Promise.resolve();
        }),
      };
      return Promise.resolve();
    });
    collector.saveSession = jest.fn().mockResolvedValue();
    collector.gate.close = jest.fn().mockResolvedValue();
    collector.cdp.close = jest.fn();
    collector.proxyTunnel = { close: jest.fn().mockResolvedValue() };
    collector.result = {
      orderNumber: ORDER,
      completeItemCount: 1,
      products: [{ name: '测试商品', quantity: 1, rawStatus: 'PICKED_UP' }],
    };
    collector.resultEvidence = { observedAt: new Date().toISOString(), sha256: 'example' };
    const previousFile = `${directory}/private/results/previous.json`;
    writePrivate(previousFile, '{"previous":true}');
    const summary = await collector.run();
    expect(summary.outcome).toBe(outcome);
    expect(summary.runId).toBe(22);
    if (outcome === 'AUTH_PRECONDITION_REQUIRED')
      expect(collector.saveSession).not.toHaveBeenCalled();
    expect(collector.proxyTunnel.close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(previousFile))).toEqual({ previous: true });
    if (outcome === 'SUCCEEDED') {
      expect(summary.result.orderNumber).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(summary.resultFile)).orderNumber).toBe(ORDER);
    } else {
      expect(summary.result).toBeUndefined();
      expect(summary.resultFile).toBeUndefined();
    }
  }
);

test.each([undefined, null, 'invalid', '0', '-1', '1.5', '9007199254740993'])(
  '无有效安全整数运行编号时摘要保持不可接受：%s',
  async runId => {
    const { EventEmitter } = require('events');
    collector.logger = Object.assign(new EventEmitter(), {
      info: jest.fn(),
      end() {
        this.emit('finish');
      },
    });
    collector.initialize = jest.fn().mockImplementation(() => {
      collector.id = runId;
      throw Object.assign(new Error('invalid input'), { code: 'INPUT_INVALID' });
    });
    collector.gate.close = jest.fn().mockResolvedValue();
    collector.cdp.close = jest.fn();
    const summary = await collector.run();
    expect(summary.outcome).toBe('INPUT_INVALID');
    expect(summary.runId).toBeNull();
  }
);

test.each(['success', 'risk', 'budget', 'attempts', 'lateRisk'])(
  '账号组复用一个浏览器，逐单身份验证并保留部分结果：%s',
  async kind => {
    const { EventEmitter } = require('events');
    collector.accountMode = true;
    collector.accountResults = [];
    collector.samples = [
      collector.sample,
      validateSample({
        ...collector.sample,
        id: 12,
        orderNumber: 'W1234567891',
        url: collector.sample.url.replace(ORDER, 'W1234567891'),
      }),
    ];
    collector.logger = Object.assign(new EventEmitter(), {
      info: jest.fn(),
      end() {
        this.emit('finish');
      },
    });
    collector.initialize = jest.fn().mockImplementation(async () => {
      await Promise.resolve();
      collector.id = '22';
      collector.started = Date.now();
    });
    collector.page = {
      goto: jest.fn(async () => {
        const number = collector.sample.orderNumber;
        collector.cdp.send.mockResolvedValue({ body: detail().replace(ORDER, number) });
        const response = JSON.parse(JSON.stringify(RESPONSE));
        response.response.url = response.response.url.replace(ORDER, number);
        if (kind === 'risk') response.response.status = 541;
        await collector.event(event('Network.responseReceived', response));
        await collector.event(
          event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 1000 })
        );
      }),
    };
    collector.launch = jest.fn().mockResolvedValue();
    collector.pageControl = {
      send: jest.fn().mockImplementation(async () => {
        await Promise.resolve();
        if (kind === 'lateRisk') collector.stop('HTTP_541');
      }),
    };
    collector.browser = { close: jest.fn().mockResolvedValue() };
    collector.saveSession = jest.fn().mockResolvedValue();
    collector.gate.startOrder = jest.fn(async () => {
      await Promise.resolve();
      if (kind === 'budget' || kind === 'attempts')
        throw Object.assign(new Error('limit'), {
          code: kind === 'budget' ? 'REQUEST_BUDGET' : 'ORDER_ATTEMPT_LIMIT',
        });
      return '23';
    });
    collector.gate.finishOrder = jest.fn().mockResolvedValue();
    collector.gate.recordFailure = jest.fn().mockResolvedValue();
    collector.gate.close = jest.fn().mockResolvedValue();
    collector.cdp.close = jest.fn();
    const summary = await collector.run();
    expect(collector.launch).toHaveBeenCalledTimes(1);
    expect(collector.browser.close).toHaveBeenCalledTimes(1);
    expect(summary.results).toHaveLength(2);
    if (kind === 'success') {
      expect(summary.results.map(result => result.outcome)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
      expect(summary.runId).toBe(23);
      expect(summary.runId).toBe(summary.results[1].runId);
      expect(
        summary.results.map(result => JSON.parse(fs.readFileSync(result.resultFile)).orderNumber)
      ).toEqual([ORDER, 'W1234567891']);
      expect(collector.page.goto).toHaveBeenCalledTimes(2);
    } else if (kind === 'risk') {
      expect(summary.results.map(result => result.outcome)).toEqual(['HTTP_541', 'HTTP_541']);
      expect(collector.page.goto).toHaveBeenCalledTimes(1);
    } else {
      expect(summary.results[0].outcome).toBe('SUCCEEDED');
      expect(summary.results[1].outcome).toBe(
        kind === 'budget'
          ? 'REQUEST_BUDGET'
          : kind === 'lateRisk'
            ? 'HTTP_541'
            : 'ORDER_ATTEMPT_LIMIT'
      );
      expect(collector.page.goto).toHaveBeenCalledTimes(1);
    }
  }
);
test.each(['980', '9007199254740993'])(
  '详情与收据均完成后规范 PostgreSQL bigint 摘要，不能接受不安全编号：%s',
  async detailRunId => {
    const { EventEmitter } = require('events');
    collector.accountMode = true;
    collector.samples = [collector.sample];
    collector.logger = Object.assign(new EventEmitter(), {
      info: jest.fn(),
      end() {
        this.emit('finish');
      },
    });
    collector.initialize = jest.fn().mockImplementation(() => {
      collector.id = detailRunId;
      collector.gate.id = detailRunId;
      return Promise.resolve();
    });
    collector.launch = jest.fn().mockResolvedValue();
    collector.collectAccount = jest.fn().mockImplementation(() => {
      collector.gate.id = '981';
      collector.stopped = 'SUCCEEDED';
      collector.accountResults = [
        {
          orderId: collector.sample.id,
          outcome: 'SUCCEEDED',
          runId: Number(detailRunId),
          attempted: true,
          receipt: { outcome: 'RECEIPT_CAPTURED', runId: 981, detailRun: Number(detailRunId) },
        },
      ];
      return Promise.resolve();
    });
    collector.captureAuthDiagnostic = jest.fn().mockResolvedValue();
    collector.saveSession = jest.fn().mockResolvedValue();
    collector.gate.close = jest.fn().mockResolvedValue();
    collector.cdp.close = jest.fn();
    const summary = await collector.run();
    if (detailRunId === '980') {
      expect(summary.outcome).toBe('SUCCEEDED');
      expect(summary.runId).toBe(980);
      expect(summary.runId).toBe(summary.results[0].runId);
      expect(summary.runId).toBe(summary.results[0].receipt.detailRun);
      expect(summary.results[0].receipt.runId).toBe(981);
    } else {
      expect(summary.outcome).toBe('COLLECTOR_IDENTITY_INVALID');
      expect(summary.runId).toBeNull();
    }
  }
);
test('账号模式切换目标后忽略旧单迟到正文，错误订单不会回写', async () => {
  collector.accountMode = true;
  await collector.event(event('Network.responseReceived', RESPONSE));
  collector.sample = { ...collector.sample, id: 12, orderNumber: 'W1234567891' };
  await collector.event(
    event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 1000 })
  );
  expect(collector.result).toBeUndefined();
  expect(collector.stopped).toBeNull();
});

test('收据阶段阻止登录跳转，允许链接仍经过全局限流', async () => {
  const url = 'https://secure6.www.apple.com.cn/shop/order/print/invoice/123/Abc';
  collector.receiptPhase = { url, urlHash: hash(url) };
  await collector.event(
    event('Fetch.requestPaused', {
      requestId: 'receipt',
      resourceType: 'Document',
      request: { url },
    })
  );
  expect(collector.gate.permit).toHaveBeenCalledTimes(1);
  await collector.event(
    event('Fetch.requestPaused', {
      requestId: 'redirect',
      resourceType: 'Document',
      request: { url: 'https://www.apple.com.cn/shop/signIn' },
    })
  );
  expect(collector.gate.permit).toHaveBeenCalledTimes(1);
  expect(collector.receiptPhase.outcome).toBe('RECEIPT_SESSION_REDIRECT');
  expect(collector.stopped).toBe('RECEIPT_SESSION_REDIRECT');
});

test.each([
  'https://secure6.www.apple.com.cn/shop/order/print/invoice/456/next-private-token',
  'https://secure6.www.apple.com.cn/shop/signIn?r=private-return',
  'https://secure6.www.apple.com.cn/unknown/private-segment?secret=value',
  'https://untrusted.example.test/private-segment?secret=value',
])('加密诊断保留目标但不会放行收据跳转：%s', async target => {
  const url =
    'https://secure6.www.apple.com.cn/shop/order/print/invoice/123/original-private-token';
  collector.id = 951;
  collector.receiptPhase = { url, urlHash: hash(url), runId: 952 };
  await collector.event(
    event('Network.requestWillBeSent', {
      requestId: 'redirect-network',
      frameId: 'main-frame',
      type: 'Document',
      request: { url: target, method: 'GET', headers: { Cookie: 'private-cookie' } },
      redirectResponse: {
        url,
        status: 302,
        headers: { Location: target, 'Set-Cookie': 'private-cookie' },
      },
      initiator: {
        type: 'script',
        url: 'https://secure6.www.apple.com.cn/private-script?token=private',
        lineNumber: 12,
        columnNumber: 2,
      },
    })
  );
  await collector.event(
    event('Fetch.requestPaused', {
      requestId: 'blocked',
      networkId: 'redirect-network',
      frameId: 'main-frame',
      resourceType: 'Document',
      request: { url: target, method: 'GET' },
    })
  );
  expect(collector.gate.permit).not.toHaveBeenCalled();
  expect(collector.cdp.send).toHaveBeenCalledWith(
    'Fetch.failRequest',
    { requestId: 'blocked', errorReason: 'Aborted' },
    's1'
  );
  expect(collector.cdp.send.mock.calls.some(([method]) => method === 'Fetch.continueRequest')).toBe(
    false
  );
  expect(collector.stopped).toBe('RECEIPT_SESSION_REDIRECT');
  const diagnostics = fs
    .readdirSync(collector.directory)
    .filter(file => file.startsWith('receipt-'));
  expect(diagnostics).toHaveLength(2);
  const decoded = diagnostics.map(file =>
    JSON.parse(decrypt(fs.readFileSync(path.join(collector.directory, file)), collector.key))
  );
  expect(decoded.find(value => value.kind === 'redirect-response')).toMatchObject({
    detailRunId: 951,
    receiptRunId: 952,
    frameId: 'main-frame',
    requestId: 'redirect-network',
    request: { url: target },
    redirectResponse: { url, status: 302, location: target },
  });
  expect(decoded.find(value => value.kind === 'blocked-document')).toMatchObject({
    networkId: 'redirect-network',
    request: { url: target },
  });
  expect(JSON.stringify(decoded)).not.toContain('private-cookie');
  const logs = JSON.stringify(collector.logger.info.mock.calls);
  for (const secret of [
    'private-token',
    'private-return',
    'private-segment',
    'private-script',
    'secret=value',
  ])
    expect(logs).not.toContain(secret);
  expect(logs).toContain(hash(target));
});

test('原收据请求只加密保存关联标识和导航头，仍经过相同gate', async () => {
  const url = 'https://secure6.www.apple.com.cn/shop/order/print/invoice/123/private-token';
  collector.receiptPhase = { url, urlHash: hash(url), runId: 2 };
  const referer =
    'https://secure6.www.apple.com.cn/shop/order/detail/private-id/W1234567890?token=secret';
  await collector.event(
    event('Fetch.requestPaused', {
      requestId: 'first-fetch',
      networkId: 'first-network',
      frameId: 'first-frame',
      resourceType: 'Document',
      request: {
        url,
        method: 'GET',
        headers: {
          Referer: referer,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'navigate',
          Cookie: 'private-cookie',
          Authorization: 'private-auth',
        },
      },
    })
  );
  expect(collector.gate.permit).toHaveBeenCalledTimes(1);
  const file = fs
    .readdirSync(collector.directory)
    .find(name => name.startsWith('receipt-initial-request-'));
  const value = JSON.parse(
    decrypt(fs.readFileSync(path.join(collector.directory, file)), collector.key)
  );
  expect(value).toMatchObject({
    frameId: 'first-frame',
    requestId: 'first-fetch',
    networkId: 'first-network',
    request: {
      headers: { referer, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
    },
  });
  expect(JSON.stringify(value)).not.toMatch(/private-cookie|private-auth/);
  expect(JSON.stringify(collector.logger.info.mock.calls)).not.toMatch(
    /private-token|private-id|token=secret/
  );
});

test('非收据阶段不密封重定向，收据诊断有次数和文本硬限', async () => {
  const url = 'https://secure6.www.apple.com.cn/shop/order/print/invoice/123/Abc';
  const params = {
    requestId: 'redirect',
    type: 'Document',
    request: { url, method: 'GET' },
    redirectResponse: { url, status: 302, headers: { Location: 'x'.repeat(9000) } },
  };
  await collector.event(event('Network.requestWillBeSent', params));
  expect(fs.readdirSync(collector.directory)).toHaveLength(0);
  collector.receiptPhase = { url, urlHash: hash(url), runId: 2 };
  for (let index = 0; index < 8; index++)
    await collector.event(event('Network.requestWillBeSent', params));
  const files = fs.readdirSync(collector.directory);
  expect(files).toHaveLength(4);
  for (const file of files) {
    const value = JSON.parse(
      decrypt(fs.readFileSync(path.join(collector.directory, file)), collector.key)
    );
    expect(value.truncated).toBe(true);
    expect(value.redirectResponse.location).toHaveLength(8192);
  }
  await collector.event(
    event('Fetch.requestPaused', {
      requestId: 'blocked-after-budget',
      resourceType: 'Document',
      request: { url: 'https://www.apple.com.cn/shop/signIn' },
    })
  );
  expect(fs.readdirSync(collector.directory)).toHaveLength(5);
  expect(collector.stopped).toBe('RECEIPT_SESSION_REDIRECT');
});

test('加密诊断写入失败仍拒绝跳转，不触发补充请求', async () => {
  const url = 'https://secure6.www.apple.com.cn/shop/order/print/invoice/123/Abc';
  collector.receiptPhase = { url, urlHash: hash(url), runId: 2 };
  collector.seal = jest.fn(() => {
    throw new Error('private-storage-error');
  });
  await collector.event(
    event('Fetch.requestPaused', {
      requestId: 'blocked',
      resourceType: 'Document',
      request: { url: 'https://www.apple.com.cn/shop/signIn' },
    })
  );
  expect(collector.stopped).toBe('RECEIPT_SESSION_REDIRECT');
  expect(collector.gate.permit).not.toHaveBeenCalled();
  expect(collector.cdp.send).toHaveBeenCalledWith(
    'Fetch.failRequest',
    { requestId: 'blocked', errorReason: 'Aborted' },
    's1'
  );
  expect(JSON.stringify(collector.logger.info.mock.calls)).not.toContain('private-storage-error');
});

test.each(['RECEIPT_SESSION_REDIRECT', 'HTTP_541', 'REQUEST_STOPPED', 'TIME_BUDGET'])(
  '迟到原收据200正文不能覆盖已有拒绝状态：%s',
  async outcome => {
    const url = 'https://secure6.www.apple.com.cn/shop/order/print/invoice/123/Abc';
    collector.receiptPhase = { url, urlHash: hash(url), runId: 2, outcome };
    collector.stopped = outcome;
    collector.cdp.send.mockResolvedValue({ body: '<html>late receipt</html>' });
    await collector.event(
      event('Network.responseReceived', {
        requestId: 'late',
        type: 'Document',
        response: { url, status: 200, mimeType: 'text/html' },
      })
    );
    await collector.event(
      event('Network.loadingFinished', { requestId: 'late', encodedDataLength: 30 })
    );
    expect(collector.receiptPhase.captured).toBeUndefined();
    expect(collector.receiptPhase.outcome).toBe(outcome);
    expect(collector.stopped).toBe(outcome);
  }
);

test('收据阶段只捕获目标链接正文，不替换详情结果', async () => {
  const url = 'https://secure6.www.apple.com.cn/shop/order/print/invoice/123/Abc';
  const old = { detail: true };
  collector.result = old;
  collector.receiptPhase = { url, urlHash: hash(url) };
  collector.cdp.send.mockResolvedValue({ body: '<html>receipt</html>' });
  await collector.event(
    event('Network.responseReceived', {
      requestId: 'r1',
      type: 'Document',
      response: { url, status: 200, mimeType: 'text/html' },
    })
  );
  await collector.event(
    event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 30 })
  );
  expect(collector.receiptPhase.captured.bytes.toString()).toBe('<html>receipt</html>');
  expect(collector.result).toBe(old);
});

test('同账号跨出口会话不得恢复', async () => {
  collector.leaseContext = {
    proxyHash: 'new',
    egressHash: 'new',
    startedAt: new Date().toISOString(),
  };
  writePrivate(
    collector.sessionFile,
    encrypt(
      {
        accountHash: collector.sample.accountHash,
        createdAt: new Date().toISOString(),
        cookies: [],
        lease: { proxyHash: 'old', egressHash: 'old', startedAt: collector.leaseContext.startedAt },
      },
      collector.key
    )
  );
  collector.context = { addCookies: jest.fn() };
  await collector.restoreSession();
  expect(collector.context.addCookies).not.toHaveBeenCalled();
  expect(collector.sessionRestored).not.toBe(true);
});
