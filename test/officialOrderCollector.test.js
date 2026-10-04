/* eslint-disable no-magic-numbers -- 测试使用显式的协议状态和请求编号。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
jest.mock('pg', () => ({ Client: jest.fn(() => ({ query: jest.fn(), end: jest.fn() })) }));
jest.mock('playwright-core', () => ({ chromium: {} }));
const OfficialOrderCollector = require('../src/services/officialOrderCollector');
const { writePrivate, hash, decrypt, encrypt } = require('../src/services/officialOrderSupport');

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
  collector.context.cookies.mockResolvedValue([{ name: 'shld_bt_ck', value: 'x'.repeat(101) }]);
  expect(await collector.waitForSiteReady()).toBe(true);
  expect(await collector.waitForSiteReady()).toBe(true);
  collector.navigateAccount = jest.fn().mockResolvedValue();
  collector.page = { frames: () => [{ url: () => 'https://example.test/', locator: jest.fn() }] };
  await collector.loginStep();
  expect(collector.passwordSubmitted).toBe(false);
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
test.each(['SUCCEEDED', 'HTTP_541', 'IDENTITY_MISMATCH'])(
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
