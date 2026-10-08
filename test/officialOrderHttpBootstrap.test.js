/* eslint-disable no-magic-numbers -- 合成登录文档、Cookie 和运行边界。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  bootstrapOfficialOrderHttp,
  loginBootstrapUrl,
  browserBootstrapCookies,
} = require('../src/services/officialOrderHttpBootstrap');
const { decrypt } = require('../src/services/officialOrderSupport');

const ACCOUNT = 'https://www.apple.com.cn/shop/goto/account';
const ACCOUNT_REDIRECT = 'https://www.apple.com.cn/cn/shop/go/account';
const ACCOUNT_HOME = 'https://secure.www.apple.com.cn/shop/account/home';
const ACCOUNT_SHARD_HOME = 'https://secure7.www.apple.com.cn/shop/account/home';
const LOGIN = 'https://secure6.www.apple.com.cn/shop/signIn/account?ssi=synthetic-private-value';
const SCRIPT = '<script id="shldVerify" src="/shop/shld/v1_2/verify.js"></script>';
let root;
let key;
let transport;
let options;

function cookie(overrides = {}) {
  return {
    name: 'shld_bt_ck',
    value: `synthetic|${Math.floor(Date.now() / 1000) + 3600}|unverified-signature`,
    domain: '.apple.com.cn',
    path: '/',
    expires: -1,
    secure: true,
    hostOnly: false,
    ...overrides,
  };
}

function response(text = '', overrides = {}) {
  return {
    status: 200,
    bodyBase64: Buffer.from(text).toString('base64'),
    headers: {},
    cookies: [],
    ...overrides,
  };
}

function queue(...responses) {
  for (const value of responses)
    transport.request.mockImplementationOnce(input =>
      Promise.resolve({ url: input.url, ...value })
    );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'official-http-bootstrap-'));
  key = crypto.randomBytes(32);
  const accountHash = 'a'.repeat(64);
  transport = {
    gate: { id: 21, accountHash },
    request: jest.fn(() => Promise.reject(new Error('UNEXPECTED_OFFLINE_REQUEST'))),
  };
  options = {
    root,
    key,
    transport,
    sample: { id: 11, orderNumber: 'W1234567890', accountHash },
    runId: 21,
  };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('同 run 逐跳取证，Cookie 交接不声明认证或订单成功', async () => {
  queue(
    response('', { status: 302, headers: { Location: LOGIN } }),
    response(SCRIPT, { cookies: [cookie()] })
  );
  const result = await bootstrapOfficialOrderHttp(options);
  expect(result.outcome).toBe('HTTP_LOGIN_BOOTSTRAP_READY');
  expect(result.loginPageUrl).toBe(LOGIN);
  expect(result.cookies).toEqual([
    expect.objectContaining({ name: 'shld_bt_ck', domain: '.apple.com.cn', expires: -1 }),
  ]);
  expect(result.cookies[0].hostOnly).toBeUndefined();
  expect(result.source.runId).toBe(21);
  expect(transport.request.mock.calls.map(([input]) => [input.url, input.method])).toEqual([
    [ACCOUNT, 'GET'],
    [LOGIN, 'GET'],
  ]);
  expect(fs.existsSync(path.join(root, 'private/results'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'private/sessions'))).toBe(false);
  const evidence = path.join(root, 'evidence/run-21');
  expect(fs.readdirSync(evidence).filter(file => file.startsWith('response-'))).toHaveLength(2);
  const record = JSON.parse(decrypt(fs.readFileSync(path.join(evidence, 'request-2.enc')), key));
  expect(record.url).toBe(LOGIN);
  expect(fs.readFileSync(path.join(evidence, 'events.jsonl'), 'utf8')).not.toContain(
    'synthetic-private-value'
  );
});

test('只按当前账户文档的唯一真实链接选择登录入口', async () => {
  queue(
    response(
      `<a href="${LOGIN}">登录</a><a href="${LOGIN}">登录</a><a href="/shop/bag">购物袋</a>`
    ),
    response(SCRIPT, { cookies: [cookie()] })
  );
  expect((await bootstrapOfficialOrderHttp(options)).loginPageUrl).toBe(LOGIN);
  expect(transport.request).toHaveBeenCalledTimes(2);
});

test('官方303精确中间入口逐跳GET，同run留证而不提交认证', async () => {
  queue(
    response('', { status: 303, headers: { location: ACCOUNT_REDIRECT } }),
    response('', { status: 302, headers: { location: LOGIN } }),
    response(SCRIPT, { cookies: [cookie()] })
  );
  const result = await bootstrapOfficialOrderHttp(options);
  expect(result.loginPageUrl).toBe(LOGIN);
  expect(result.source.runId).toBe(21);
  expect(transport.request.mock.calls.map(([input]) => [input.url, input.method])).toEqual([
    [ACCOUNT, 'GET'],
    [ACCOUNT_REDIRECT, 'GET'],
    [LOGIN, 'GET'],
  ]);
  const record = JSON.parse(
    decrypt(fs.readFileSync(path.join(root, 'evidence/run-21/request-2.enc')), key)
  );
  expect(record).toMatchObject({ url: ACCOUNT_REDIRECT, method: 'GET', body: null });
});

test('中间入口即使200带Cookie也不能被误称为登录就绪文档', async () => {
  queue(
    response('', { status: 303, headers: { location: ACCOUNT_REDIRECT } }),
    response(SCRIPT, { cookies: [cookie()] })
  );
  await expect(bootstrapOfficialOrderHttp(options)).rejects.toMatchObject({
    code: 'BOOTSTRAP_LOGIN_LINK_AMBIGUOUS',
  });
});

test('官方303和301经账户首页继续追随登录页，同run逐跳GET留证', async () => {
  queue(
    response('', { status: 303, headers: { location: ACCOUNT_REDIRECT } }),
    response('', { status: 301, headers: { location: ACCOUNT_HOME } }),
    response('', { status: 302, headers: { location: LOGIN } }),
    response(SCRIPT, { cookies: [cookie()] })
  );
  const result = await bootstrapOfficialOrderHttp(options);
  expect(result.outcome).toBe('HTTP_LOGIN_BOOTSTRAP_READY');
  expect(result.loginPageUrl).toBe(LOGIN);
  expect(result.source.runId).toBe(21);
  expect(transport.request.mock.calls.map(([input]) => [input.url, input.method])).toEqual([
    [ACCOUNT, 'GET'],
    [ACCOUNT_REDIRECT, 'GET'],
    [ACCOUNT_HOME, 'GET'],
    [LOGIN, 'GET'],
  ]);
  const record = JSON.parse(
    decrypt(fs.readFileSync(path.join(root, 'evidence/run-21/request-3.enc')), key)
  );
  expect(record).toMatchObject({ url: ACCOUNT_HOME, method: 'GET', body: null });
});

test('账户首页200仅能按唯一真实链接继续到登录页', async () => {
  queue(
    response('', { status: 303, headers: { location: ACCOUNT_REDIRECT } }),
    response('', { status: 301, headers: { location: ACCOUNT_HOME } }),
    response(`<a href="${LOGIN}">登录</a>`, { cookies: [cookie()] }),
    response(SCRIPT, { cookies: [cookie()] })
  );
  expect((await bootstrapOfficialOrderHttp(options)).loginPageUrl).toBe(LOGIN);
  expect(transport.request).toHaveBeenCalledTimes(4);
});

test.each(['redirect', 'link'])(
  '仅跟随服务端%s给出的精确signIn登录页，保留当前查询',
  async source => {
    const login = 'https://secure7.www.apple.com.cn/shop/signIn?r=synthetic-current-server-value';
    queue(
      response('', { status: 303, headers: { location: ACCOUNT_REDIRECT } }),
      response('', { status: 301, headers: { location: ACCOUNT_HOME } }),
      source === 'redirect'
        ? response('', { status: 303, headers: { location: login } })
        : response(`<a href="${login}">登录</a>`),
      response(SCRIPT, { cookies: [cookie()] })
    );
    const result = await bootstrapOfficialOrderHttp(options);
    expect(result.loginPageUrl).toBe(login);
    expect(result.outcome).toBe('HTTP_LOGIN_BOOTSTRAP_READY');
    expect(transport.request.mock.calls[3][0]).toMatchObject({ url: login, method: 'GET' });
  }
);

test.each([
  'https://secure7.www.apple.com.cn/shop/signIn/',
  'https://secure7.www.apple.com.cn/shop/signIn/other',
  'https://secure7.www.apple.com.cn/shop/signIn#fragment',
  'https://secure7.www.apple.com.cn/shop/signIn#',
  'https://secure7.www.apple.com.cn/shop/signIn/account#',
  'https://www.apple.com.cn/shop/signIn',
  'https://securex.www.apple.com.cn/shop/signIn',
])('服务端登录页仍不接受其他子路径、host或hash：%s', async location => {
  queue(response('', { status: 303, headers: { location } }));
  await expect(bootstrapOfficialOrderHttp(options)).rejects.toMatchObject({
    code: 'BOOTSTRAP_DESTINATION_DENIED',
  });
  expect(transport.request).toHaveBeenCalledTimes(1);
});

test('官方账户首页303切换数字分片后继续登录页，保持同run逐跳GET', async () => {
  queue(
    response('', { status: 303, headers: { location: ACCOUNT_REDIRECT } }),
    response('', { status: 301, headers: { location: ACCOUNT_HOME } }),
    response('', { status: 303, headers: { location: ACCOUNT_SHARD_HOME } }),
    response('', { status: 302, headers: { location: LOGIN } }),
    response(SCRIPT, { cookies: [cookie()] })
  );
  const result = await bootstrapOfficialOrderHttp(options);
  expect(result.outcome).toBe('HTTP_LOGIN_BOOTSTRAP_READY');
  expect(result.loginPageUrl).toBe(LOGIN);
  expect(result.source.runId).toBe(21);
  expect(transport.request.mock.calls.map(([input]) => [input.url, input.method])).toEqual([
    [ACCOUNT, 'GET'],
    [ACCOUNT_REDIRECT, 'GET'],
    [ACCOUNT_HOME, 'GET'],
    [ACCOUNT_SHARD_HOME, 'GET'],
    [LOGIN, 'GET'],
  ]);
});

test.each([ACCOUNT_HOME, ACCOUNT_SHARD_HOME])(
  '账户首页即使200带Cookie也不代表登录页就绪：%s',
  async home => {
    queue(
      response('', { status: 302, headers: { location: home } }),
      response(SCRIPT, { cookies: [cookie()] })
    );
    await expect(bootstrapOfficialOrderHttp(options)).rejects.toMatchObject({
      code: 'BOOTSTRAP_LOGIN_LINK_AMBIGUOUS',
    });
    expect(transport.request).toHaveBeenCalledTimes(2);
  }
);

test.each([
  ACCOUNT_HOME + '?next=synthetic',
  ACCOUNT_HOME + '?',
  ACCOUNT_HOME + '#fragment',
  ACCOUNT_HOME + '#',
  ACCOUNT_HOME + '/',
  ACCOUNT_HOME.replace('/home', '/orders'),
  ACCOUNT_HOME.replace('secure.', 'securex.'),
  ACCOUNT_HOME.replace('secure.', ''),
  ACCOUNT_SHARD_HOME + '?next=synthetic',
  ACCOUNT_SHARD_HOME + '?',
  ACCOUNT_SHARD_HOME + '#fragment',
  ACCOUNT_SHARD_HOME + '#',
  ACCOUNT_SHARD_HOME + '/',
  ACCOUNT_SHARD_HOME.replace('/home', '/orders'),
])('拒绝未观察到的账户首页变体，重定向后不发送请求：%s', async location => {
  queue(response('', { status: 301, headers: { location } }));
  await expect(bootstrapOfficialOrderHttp(options)).rejects.toMatchObject({
    code: 'BOOTSTRAP_DESTINATION_DENIED',
  });
  expect(transport.request).toHaveBeenCalledTimes(1);
});

test.each([
  ACCOUNT_REDIRECT + '?next=synthetic',
  ACCOUNT_REDIRECT + '?',
  ACCOUNT_REDIRECT + '#fragment',
  ACCOUNT_REDIRECT + '#',
  ACCOUNT_REDIRECT + '/',
  ACCOUNT_REDIRECT.replace('/account', '/orders'),
  ACCOUNT_REDIRECT.replace('/go/', '/goto/'),
  ACCOUNT_REDIRECT.replace('www.', 'secure6.www.'),
])('拒绝未观察到的cn/go变体，重定向后不发送请求：%s', async location => {
  queue(response('', { status: 303, headers: { location } }));
  await expect(bootstrapOfficialOrderHttp(options)).rejects.toMatchObject({
    code: 'BOOTSTRAP_DESTINATION_DENIED',
  });
  expect(transport.request).toHaveBeenCalledTimes(1);
});

test('由当前登录页发现 Shld 路由并复用原证据采集器', async () => {
  const challenge = {
    algorithm: 'SHA256',
    salt: 'synthetic',
    challenge: crypto.createHash('sha256').update('synthetic0').digest('hex'),
    timeout: 100,
  };
  queue(
    response('', { status: 302, headers: { location: LOGIN } }),
    response(SCRIPT),
    response(JSON.stringify(challenge)),
    response('{}', { cookies: [cookie()] })
  );
  expect((await bootstrapOfficialOrderHttp(options)).outcome).toBe('HTTP_LOGIN_BOOTSTRAP_READY');
  const requests = transport.request.mock.calls.map(([input]) => input);
  expect(requests).toHaveLength(4);
  expect(requests[2].url).toBe('https://secure6.www.apple.com.cn/shop/shld/work/v1_2/q');
  expect(requests[3].method).toBe('POST');
  expect(requests.every(input => !input.url.includes('/appleauth/'))).toBe(true);
});

test.each([
  ['https://idmsa.apple.com/appleauth/auth/signin', 'BOOTSTRAP_DESTINATION_DENIED'],
  ['https://secure6.www.apple.com.cn/shop/checkout/review', 'BOOTSTRAP_DESTINATION_DENIED'],
  ['https://securex.www.apple.com.cn/shop/account/home', 'BOOTSTRAP_DESTINATION_DENIED'],
  [LOGIN + '#fragment', 'BOOTSTRAP_DESTINATION_DENIED'],
  ['https://example.test/shop/signIn/account', 'DESTINATION_DENIED'],
])('不向不允许的重定向目标发送请求：%s', async (location, code) => {
  queue(response('', { status: 302, headers: { location } }));
  await expect(bootstrapOfficialOrderHttp(options)).rejects.toMatchObject({ code });
  expect(transport.request).toHaveBeenCalledTimes(1);
});

test.each(['', `<a href="${LOGIN}">一</a><a href="${LOGIN}&other=1">二</a>`])(
  '无唯一登录入口即停止，不构造路径',
  async html => {
    queue(response(html));
    await expect(bootstrapOfficialOrderHttp(options)).rejects.toMatchObject({
      code: 'BOOTSTRAP_LOGIN_LINK_AMBIGUOUS',
    });
  }
);

test('重定向循环立即停止，次数不耗到上限', async () => {
  queue(response('', { status: 302, headers: { location: ACCOUNT } }));
  await expect(bootstrapOfficialOrderHttp(options)).rejects.toMatchObject({
    code: 'BOOTSTRAP_REDIRECT_LOOP',
  });
  expect(transport.request).toHaveBeenCalledTimes(1);
});

test('失败或其他 gate 不能启动前置请求', async () => {
  transport.gate.id = 22;
  await expect(bootstrapOfficialOrderHttp(options)).rejects.toMatchObject({
    code: 'BOOTSTRAP_GATE_MISMATCH',
  });
  expect(transport.request).not.toHaveBeenCalled();
});

test('其他账号不能借用已打开的 gate', async () => {
  transport.gate.accountHash = 'b'.repeat(64);
  await expect(bootstrapOfficialOrderHttp(options)).rejects.toMatchObject({
    code: 'BOOTSTRAP_GATE_MISMATCH',
  });
  expect(transport.request).not.toHaveBeenCalled();
});

test.each([407, 412, 429, 541])('HTTP %i 不重试、不提交认证', async status => {
  queue(response('', { status }));
  await expect(bootstrapOfficialOrderHttp(options)).rejects.toMatchObject({
    code: `HTTP_${status}`,
  });
  expect(transport.request).toHaveBeenCalledTimes(1);
});

test('Cookie 保持 host-only、HttpOnly、SameSite，不保留未知字段', () => {
  const result = browserBootstrapCookies([
    cookie({
      domain: 'secure6.www.apple.com.cn',
      hostOnly: true,
      httpOnly: true,
      sameSite: 'Lax',
      debug: 'private',
    }),
  ]);
  expect(result[0]).toMatchObject({
    domain: 'secure6.www.apple.com.cn',
    httpOnly: true,
    sameSite: 'Lax',
  });
  expect(result[0].debug).toBeUndefined();
});

test.each([
  { domain: '.example.test' },
  { expires: 1 },
  { hostOnly: undefined },
  { value: 'bad\nvalue' },
])('拒绝不可安全注入的 Cookie %p', overrides => {
  expect(() => browserBootstrapCookies([cookie(overrides)])).toThrow('BOOTSTRAP_COOKIES_INVALID');
});

test('登录 GET 参数保持私密，入口不可加任意查询', () => {
  expect(loginBootstrapUrl(LOGIN).href).toBe(LOGIN);
  expect(() => loginBootstrapUrl(ACCOUNT + '?redirect=https://example.test')).toThrow(
    'BOOTSTRAP_DESTINATION_DENIED'
  );
});
