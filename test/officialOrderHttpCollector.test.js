/* eslint-disable no-magic-numbers -- 离线 HTTP 状态、权限和合成订单边界。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
const {
  GUEST_ACTION_BUNDLE,
  GUEST_ACTION_INTEGRITY,
} = require('../src/services/officialOrderGuestAction');
const shield = require('../src/services/officialOrderShield');
const receiptParser = require('../src/services/officialOrderReceipt');
const { decrypt, hash, readPrivate } = require('../src/services/officialOrderSupport');
const {
  OfficialOrderHttpCollector,
  discoverShieldUrl,
  validateReadUrl,
} = require('../src/services/officialOrderHttpCollector');

jest.mock('../src/services/officialOrderShield', () => ({
  ...jest.requireActual('../src/services/officialOrderShield'),
  solveShieldChallenge: jest.fn(),
}));

jest.mock('../src/services/officialOrderReceipt', () => {
  const original = jest.requireActual('../src/services/officialOrderReceipt');
  return {
    ...original,
    extractOfficialReceiptUrl: jest.fn(original.extractOfficialReceiptUrl),
    parseOfficialReceipt: jest.fn(original.parseOfficialReceipt),
  };
});

const ORDER = 'W1234567890';
const OTHER_ORDER = 'W9999999999';
const HOST = 'secure6.www.apple.com.cn';
const ORIGIN = `https://${HOST}`;
const TOKEN = 'synthetic-private-token-'.repeat(4);
const ENTRY = `https://www.apple.com.cn/xc/cn/vieworder/${ORDER}/owner@example.test`;
const GUEST = `${ORIGIN}/shop/order/guest/${ORDER}/${TOKEN}`;
const ACTION = `${ORIGIN}/shop/orderx/guestx/${ORDER}/${TOKEN}?_a=fetchOrder&_m=guestOrderSpinner`;
const RECEIPT = `${ORIGIN}/shop/order/print/invoice/syntheticInvoice/${TOKEN}`;
const SHIELD_ROUTE = `${ORIGIN}/shop/shld/work/v1_2/q`;
const SHIELD_SCRIPT = '<script id="shldVerify" src="/shop/shld/v1_2/verify.js"></script>';
const SECRET = 'synthetic-sensitive-model-token';
let root;
let key;
let collector;
let transport;

function detail(overrides = {}) {
  const model = buildLifecycleJson('PICKED_UP');
  Object.assign(model.orderDetail.orderHeader.d, { invoiceUrl: RECEIPT }, overrides);
  const item = model.orderDetail.orderItems[model.orderDetail.orderItems.c[0]];
  item.orderItemDetails.d.quantity = 2;
  item.orderItemDetails.d.deliveryDate = '于 2026年10月5日 取货';
  return JSON.stringify(model);
}

// 与 officialOrderReceipt.test.js 相同的已观察字段结构，身份和 SN 均为合成值。
function receipt({ orderNumber = ORDER, serials = ['A123456789', 'B123456789'] } = {}) {
  return JSON.stringify({
    orderInvoices: {
      c: ['orderInvoice-1'],
      'orderInvoice-1': {
        invoiceOrderSummary: { d: { orderNumber } },
        invoiceLineItems: {
          c: ['invoiceLineItem-1'],
          'invoiceLineItem-1': {
            d: {
              hasLineItemSerialInfo: true,
              lineItemSerialInfo: serials,
              quantityOrdered: String(serials.length),
              quantityShipped: String(serials.length),
              partNumber: 'TESTCH/A',
              productName: '测试手机 256GB 蓝色',
            },
          },
        },
      },
    },
  });
}

function guestPage() {
  const model = {
    meta: {
      h: {
        'x-aos-model-page': 'synthetic-page',
        modelVersion: 'v0',
        'x-aos-stk': SECRET,
        syntax: 'synthetic',
      },
    },
    guestOrderSpinner: {
      a: { fetchOrder: { url: ACTION } },
      b: { fetchOrder: { events: [{ on: 'click', do: 'a.fetchOrder' }] } },
    },
  };
  return (
    `<script id="init_data" type="application/json">${JSON.stringify(model)}</script>` +
    '<script id="uiConfig" type="application/json">' +
    '{"fetchHeaders":{"sendHeaders":false}}</script>' +
    `<script integrity="${GUEST_ACTION_INTEGRITY}" src="${GUEST_ACTION_BUNDLE}"></script>` +
    SHIELD_SCRIPT
  );
}

function cookie(overrides = {}) {
  return {
    name: 'shld_bt_ck',
    value: `synthetic|${Math.floor(Date.now() / 1000) + 3600}|unverified-signature`,
    domain: '.apple.com.cn',
    path: '/',
    expires: -1,
    secure: true,
    ...overrides,
  };
}

function challenge() {
  return JSON.stringify({
    algorithm: 'SHA256',
    salt: 'synthetic',
    challenge: crypto.createHash('sha256').update('synthetic0').digest('hex'),
    timeout: 100,
  });
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'official-http-collector-'));
  key = crypto.randomBytes(32);
  transport = { request: jest.fn(() => Promise.reject(new Error('UNEXPECTED_OFFLINE_REQUEST'))) };
  collector = new OfficialOrderHttpCollector({
    transport,
    sample: { id: 11, orderNumber: ORDER, url: GUEST },
    root,
    key,
    runId: 21,
  });
  receiptParser.extractOfficialReceiptUrl.mockClear();
  receiptParser.parseOfficialReceipt.mockClear();
  shield.solveShieldChallenge
    .mockReset()
    .mockImplementation(
      jest.requireActual('../src/services/officialOrderShield').solveShieldChallenge
    );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('每一跳请求的只读边界', () => {
  test('入口与相对重定向均交给传输层一次，逐跳留证', async () => {
    const next = `${ORIGIN}/shop/order/detail/123/${ORDER}`;
    queue(
      response('', { status: 302, headers: { Location: GUEST } }),
      response('', { status: 307, headers: { location: `/shop/order/detail/123/${ORDER}` } }),
      response(detail())
    );
    expect((await collector.navigate(ENTRY)).url).toBe(next);
    expect(transport.request.mock.calls.map(([input]) => [input.url, input.method])).toEqual([
      [ENTRY, 'GET'],
      [GUEST, 'GET'],
      [next, 'GET'],
    ]);
    expect(
      fs.readdirSync(collector.directory).filter(name => name.startsWith('response-'))
    ).toHaveLength(3);
  });

  test.each([
    ['https://idmsa.apple.com/appleauth/auth/signin', 'AUTHENTICATION_REQUIRED'],
    [`${ORIGIN}/shop/signIn/account`, 'AUTHENTICATION_REQUIRED'],
    [`${ORIGIN}/shop/checkout/review`, 'READ_DESTINATION_DENIED'],
    ['https://example.test/shop/order/guest/x/y', 'DESTINATION_DENIED'],
    ['http://www.apple.com.cn/shop/order/guest/x/y', 'DESTINATION_DENIED'],
  ])('拒绝转向 %s，目标不会收到请求', async (location, code) => {
    queue(response('', { status: 302, headers: { location } }));
    await expect(collector.navigate(GUEST)).rejects.toMatchObject({ code });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  test('重定向数量有界，缺失 Location 明确失败', async () => {
    queue(
      ...Array.from({ length: 9 }, () =>
        response('', { status: 302, headers: { location: GUEST } })
      )
    );
    await expect(collector.navigate(GUEST)).rejects.toMatchObject({ code: 'REDIRECT_LIMIT' });
    expect(transport.request).toHaveBeenCalledTimes(9);
    transport.request.mockClear();
    queue(response('', { status: 302 }));
    await expect(collector.navigate(GUEST)).rejects.toMatchObject({
      code: 'REDIRECT_LOCATION_MISSING',
    });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  test('传输层偷偷跟随重定向时拒绝结果，不保存成功文件', async () => {
    queue(response(detail(), { url: `${ORIGIN}/shop/order/detail/123/${ORDER}` }));
    await expect(collector.collect()).rejects.toMatchObject({
      code: 'UNEXPECTED_TRANSPORT_REDIRECT',
    });
    expect(fs.existsSync(`${root}/private/results`)).toBe(false);
  });

  test.each([401, 403, 407, 409, 412, 429, 500, 503, 541])(
    'HTTP %i 不重试且保留密文响应',
    async status => {
      queue(response('synthetic-failure', { status }));
      await expect(collector.navigate(GUEST)).rejects.toMatchObject({ code: `HTTP_${status}` });
      expect(transport.request).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(`${collector.directory}/response-1.enc`)).toBe(true);
    }
  );

  test('429 将更长 Retry-After 留给持久化保护层，不缩短服务器期限', async () => {
    queue(response('synthetic-risk', { status: 429, headers: { 'Retry-After': '7200' } }));
    await expect(collector.navigate(GUEST)).rejects.toMatchObject({
      code: 'HTTP_429',
      retryAfter: '7200',
    });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  test.each([
    [`${ORIGIN}/shop/checkout/review`, 'GET'],
    [`${ORIGIN}/shop/bagx/checkout_now`, 'POST'],
    [`${ORIGIN}/appleauth/auth/signin/complete`, 'POST'],
    [GUEST, 'DELETE'],
  ])('直接请求同样拒绝写操作路径 %s %s', async (url, method) => {
    await expect(collector.request(url, method)).rejects.toMatchObject({
      code: 'READ_DESTINATION_DENIED',
    });
    expect(transport.request).not.toHaveBeenCalled();
  });

  test.each([
    [ACTION.replace('fetchOrder', 'cancelOrder'), 'POST'],
    [ACTION + '&_a=cancelOrder', 'POST'],
    [ACTION + '&e=false', 'POST'],
    [ACTION + '&e=true&e=true', 'POST'],
    [ACTION + '&redirect=checkout', 'POST'],
    [GUEST + '?_a=cancelOrder', 'GET'],
  ])('允许的路径不能携带另一个动作 %s', (url, method) => {
    expect(() => validateReadUrl(url, method)).toThrow('READ_DESTINATION_DENIED');
  });

  test('保留当前官网访客动作携带的可选 e=true', () => {
    expect(validateReadUrl(ACTION + '&e=true', 'POST').href).toBe(ACTION + '&e=true');
  });

  test('只有显式登录引导允许两个 GET 路径，认证 POST 仍拒绝', () => {
    const login = `${ORIGIN}/shop/signIn/account?r=opaque-current-server-value`;
    expect(validateReadUrl(login, 'GET', true).href).toBe(login);
    expect(
      validateReadUrl('https://www.apple.com.cn/shop/goto/account', 'GET', true).pathname
    ).toBe('/shop/goto/account');
    expect(() => validateReadUrl(login)).toThrow('READ_DESTINATION_DENIED');
    expect(() => validateReadUrl(login, 'POST', true)).toThrow('READ_DESTINATION_DENIED');
    expect(() => validateReadUrl(login + '#fragment', 'GET', true)).toThrow(
      'READ_DESTINATION_DENIED'
    );
    expect(() => validateReadUrl(`${ORIGIN}/shop/account/settings`, 'GET', true)).toThrow(
      'READ_DESTINATION_DENIED'
    );
  });
});

describe('挑战与 Cookie 不构成订单成功', () => {
  test('只发现同源且唯一的版本化官方脚本地址，不执行脚本', () => {
    expect(discoverShieldUrl(SHIELD_SCRIPT, GUEST)).toBe(SHIELD_ROUTE);
    for (const html of [
      '<script>throw new Error("not executed")</script>',
      SHIELD_SCRIPT + SHIELD_SCRIPT,
      SHIELD_SCRIPT.replace('/shop/shld/', 'https://example.test/shop/shld/'),
      SHIELD_SCRIPT.replace('verify.js', 'verify.js?redirect=1'),
      SHIELD_SCRIPT.replace('v1_2', '../checkout'),
    ])
      expect(() => discoverShieldUrl(html, GUEST)).toThrow();
  });

  test('挑战页面与详情动作不同源时，发请求前拒绝', async () => {
    await expect(
      collector.ensureShield(
        { url: GUEST, text: SHIELD_SCRIPT },
        ACTION.replace('secure6.', 'secure7.')
      )
    ).rejects.toMatchObject({ code: 'SHIELD_ROUTE_INVALID' });
    expect(transport.request).not.toHaveBeenCalled();
  });

  test('未求出解不能 POST，不能发送详情动作', async () => {
    shield.solveShieldChallenge.mockReturnValue({ found: false, number: null, reason: 'TIMEOUT' });
    queue(response(guestPage()), response(challenge()));
    await expect(collector.collect()).rejects.toMatchObject({ code: 'SHIELD_NOT_SOLVED' });
    expect(transport.request.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'GET']);
    expect(fs.existsSync(`${root}/private/results`)).toBe(false);
  });

  test('未知挑战算法 fail closed，不提交回退答案', async () => {
    queue(response(guestPage()), response(challenge().replace('SHA256', 'MD5')));
    await expect(collector.collect()).rejects.toMatchObject({
      code: 'SHIELD_ALGORITHM_UNSUPPORTED',
    });
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  test('求出解但未得到有效 Cookie 时不能派发详情', async () => {
    queue(response(guestPage()), response(challenge()), response('{}'));
    await expect(collector.collect()).rejects.toMatchObject({ code: 'SHIELD_NOT_ACCEPTED' });
    expect(transport.request.mock.calls.map(([input]) => input.url)).toEqual([
      GUEST,
      SHIELD_ROUTE,
      SHIELD_ROUTE,
    ]);
  });

  test('挑战收到 302 即使附带 Cookie 也不能当作成功接受', async () => {
    queue(response(challenge()), response('', { status: 302, cookies: [cookie()] }));
    await expect(collector.ensureShield({ url: GUEST, text: SHIELD_SCRIPT })).rejects.toThrow();
  });

  test('取得本地有效 Cookie 后仍须得到完整详情，加载页不能成功', async () => {
    queue(
      response(guestPage()),
      response(challenge()),
      response('{}', { cookies: [cookie()] }),
      response('<html>loading</html>')
    );
    await expect(collector.collect()).rejects.toMatchObject({ code: 'NO_VALID_ORDER_DATA' });
    expect(transport.request.mock.calls[3][0]).toMatchObject({
      url: ACTION,
      method: 'POST',
      body: '',
    });
    expect(fs.existsSync(`${root}/private/results`)).toBe(false);
  });

  test('已有有效 Cookie 可略过计算，但还需新鲜身份匹配详情', async () => {
    queue(response(guestPage(), { cookies: [cookie()] }), response(detail()), response(receipt()));
    expect(await collector.collect()).toMatchObject({
      outcome: 'SUCCEEDED',
      receiptOutcome: 'RECEIPT_VERIFIED',
    });
    expect(shield.solveShieldChallenge).not.toHaveBeenCalled();
    expect(transport.request.mock.calls.map(([input]) => input.url)).toEqual([
      GUEST,
      ACTION,
      RECEIPT,
    ]);
  });

  test('Cookie 只适用访客文档路径时，必须为真正详情 POST 获取适用 Cookie', async () => {
    queue(
      response(guestPage(), { cookies: [cookie({ path: '/shop/order' })] }),
      response(challenge()),
      response('{}', { cookies: [cookie({ path: '/shop/orderx' })] }),
      response(detail()),
      response(receipt())
    );
    expect(await collector.collect()).toMatchObject({ outcome: 'SUCCEEDED' });
    expect(shield.solveShieldChallenge).toHaveBeenCalledTimes(1);
    expect(transport.request.mock.calls[1][0]).toMatchObject({ url: SHIELD_ROUTE, method: 'GET' });
    expect(transport.request.mock.calls[3][0]).toMatchObject({ url: ACTION, method: 'POST' });
  });

  test('Cookie 已适用详情 POST 时，不因不适用访客文档而重复挑战', async () => {
    queue(
      response(guestPage(), { cookies: [cookie({ path: '/shop/orderx' })] }),
      response(detail()),
      response(receipt())
    );
    expect(await collector.collect()).toMatchObject({ outcome: 'SUCCEEDED' });
    expect(shield.solveShieldChallenge).not.toHaveBeenCalled();
    expect(transport.request.mock.calls[1][0]).toMatchObject({ url: ACTION, method: 'POST' });
  });

  test.each([
    [challenge(), 0, 'text/plain;charset=UTF-8'],
    [
      JSON.stringify({ low: 2, high: 4, parts: 2, result: '8', timeout: 100 }),
      [2, 4],
      'application/json; charset=UTF-8',
    ],
  ])('真实离线算法答案只提交一次并继续校验详情 %#', async (body, number, contentType) => {
    queue(
      response(guestPage()),
      response(body),
      response('{}', { cookies: [cookie()] }),
      response(detail()),
      response(receipt())
    );
    expect(await collector.collect()).toMatchObject({
      outcome: 'SUCCEEDED',
      receiptOutcome: 'RECEIPT_VERIFIED',
    });
    const submission = transport.request.mock.calls[2][0];
    expect(submission).toMatchObject({
      url: SHIELD_ROUTE,
      method: 'POST',
      headers: { 'Content-Type': contentType, Origin: ORIGIN, Referer: GUEST },
    });
    expect(JSON.parse(submission.body)).toMatchObject({ number, took: expect.any(Number) });
    expect(transport.request).toHaveBeenCalledTimes(5);
  });

  test.each([
    { domain: '.example.test' },
    { domain: '.com.cn' },
    { path: '/appleauth' },
    { path: '/shop/order/guest-other' },
    { value: 'synthetic|1|expired' },
  ])('不适用当前请求的 Cookie 不算接受 %j', overrides => {
    collector.cookies = [cookie(overrides)];
    expect(collector.hasShieldCookie(GUEST)).toBe(false);
  });

  test('Cookie 匹配主机及路径边界，不要求整站 Path', () => {
    collector.cookies = [cookie({ domain: HOST, path: '/shop/order' })];
    expect(collector.hasShieldCookie(GUEST)).toBe(true);
  });

  test('hostOnly Cookie 不扩大到子域，精确主机仍可使用', () => {
    collector.cookies = [cookie({ domain: 'apple.com.cn', hostOnly: true })];
    expect(collector.hasShieldCookie(GUEST)).toBe(false);
    collector.cookies = [cookie({ domain: HOST, hostOnly: true })];
    expect(collector.hasShieldCookie(GUEST)).toBe(true);
  });
});

describe('订单、收据数量和私密来源证据', () => {
  test('显式不采集收据时，有 invoiceUrl 的详情仍完整保存且不解析或请求收据', async () => {
    collector = new OfficialOrderHttpCollector({
      transport,
      sample: { id: 11, orderNumber: ORDER, url: GUEST },
      root,
      key,
      runId: 21,
      collectReceipt: false,
    });
    const body = detail();
    queue(response(body));
    const summary = await collector.collect();
    expect(summary).toEqual({
      outcome: 'SUCCEEDED',
      orderId: 11,
      runId: 21,
      resultFile: `${root}/private/results/order-11-run-21.json`,
      receiptOutcome: 'RECEIPT_NOT_REQUESTED',
    });
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(transport.request).toHaveBeenCalledWith({
      url: GUEST,
      method: 'GET',
      headers: {},
      body: undefined,
    });
    expect(receiptParser.extractOfficialReceiptUrl).not.toHaveBeenCalled();
    expect(receiptParser.parseOfficialReceipt).not.toHaveBeenCalled();
    expect(fs.existsSync(`${root}/private/http-receipt-11-run-21.json`)).toBe(false);
    const result = readPrivate(summary.resultFile);
    expect(result).toMatchObject({ systemOrderId: 11, orderNumber: ORDER, identityMatched: true });
    expect(result.products[0]).toMatchObject({ quantity: 2, rawStatus: 'PICKED_UP' });
    expect(result.source.sha256).toBe(hash(Buffer.from(body)));
    expect(
      decrypt(fs.readFileSync(`${collector.directory}/${result.source.file}`), key).toString('utf8')
    ).toBe(body);
    expect(fs.existsSync(`${collector.directory}/request-2.enc`)).toBe(false);
  });

  test('不采集收据仍拒绝错误订单详情', async () => {
    collector.collectReceipt = false;
    queue(response(detail({ orderNumber: OTHER_ORDER })));
    await expect(collector.collect()).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${root}/private/results`)).toBe(false);
    expect(receiptParser.extractOfficialReceiptUrl).not.toHaveBeenCalled();
  });

  test('错误订单详情绝不成为目标订单，也不继续访问收据', async () => {
    queue(response(detail({ orderNumber: OTHER_ORDER })));
    await expect(collector.collect()).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${root}/private/results`)).toBe(false);
  });

  test('完整详情与电子收据绑定同一运行、订单、响应摘要和数量', async () => {
    queue(response(detail()), response(receipt()));
    const summary = await collector.collect();
    expect(summary).toMatchObject({
      outcome: 'SUCCEEDED',
      orderId: 11,
      runId: 21,
      receiptOutcome: 'RECEIPT_VERIFIED',
    });
    const result = readPrivate(summary.resultFile);
    const recorded = readPrivate(`${root}/private/http-receipt-11-run-21.json`);
    expect(result).toMatchObject({
      systemOrderId: 11,
      orderNumber: ORDER,
      identityMatched: true,
      completeItemCount: 1,
    });
    expect(result.products[0]).toMatchObject({ quantity: 2, rawStatus: 'PICKED_UP' });
    expect(recorded).toMatchObject({
      systemOrderId: 11,
      detailRun: 21,
      detailSha256: result.source.sha256,
      urlHash: hash(RECEIPT),
      egressVerifiedAfter: false,
      parsed: {
        orderNumber: ORDER,
        items: [{ serialNumber: 'A123456789' }, { serialNumber: 'B123456789' }],
      },
    });
    expect(summary).not.toHaveProperty('serialNumbers');
    expect(JSON.stringify(summary)).not.toContain(ORDER);
  });

  test.each([
    [{ serials: ['A123456789'] }, 'RECEIPT_QUANTITY_MISMATCH'],
    [{ orderNumber: OTHER_ORDER }, 'RECEIPT_ORDER_MISMATCH'],
    [{ serials: ['A123456789', 'A123456789'] }, 'RECEIPT_SERIAL_INVALID'],
  ])('收据错误独立失败并保留已验证详情：%s', async (options, code) => {
    queue(response(detail()), response(receipt(options)));
    const summary = await collector.collect();
    expect(summary).toMatchObject({ outcome: 'SUCCEEDED', receiptOutcome: code });
    expect(fs.existsSync(summary.resultFile)).toBe(true);
    expect(fs.existsSync(`${root}/private/http-receipt-11-run-21.json`)).toBe(false);
  });

  test('收据重定向不跟随登录，不生成序列号证据', async () => {
    queue(
      response(detail()),
      response('', {
        status: 302,
        headers: { location: 'https://idmsa.apple.com/appleauth/auth/signin' },
      })
    );
    expect(await collector.collect()).toMatchObject({
      receiptOutcome: 'RECEIPT_AUTHENTICATION_REQUIRED',
    });
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(`${root}/private/http-receipt-11-run-21.json`)).toBe(false);
  });

  test.each([407, 429, 541])('收据 HTTP %i 仍触发保护性停止，已验证详情留存', async status => {
    queue(response(detail()), response('synthetic-risk', { status }));
    const failure = await collector.collect().catch(error => error);
    expect(failure).toMatchObject({
      code: `HTTP_${status}`,
      detailResultFile: `${root}/private/results/order-11-run-21.json`,
    });
    expect(readPrivate(failure.detailResultFile).orderNumber).toBe(ORDER);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(`${root}/private/http-receipt-11-run-21.json`)).toBe(false);
  });

  test('原始正文、敏感头、Cookie 均加密，公开台账只保留脱敏来源', async () => {
    const body = `${detail()}\n`;
    queue(
      response(body, { headers: { 'set-cookie': SECRET }, cookies: [cookie()] }),
      response(receipt())
    );
    const summary = await collector.collect();
    const result = readPrivate(summary.resultFile);
    const bytes = fs.readFileSync(`${collector.directory}/${result.source.file}`);
    expect(decrypt(bytes, key).toString('utf8')).toBe(body);
    expect(result.source.sha256).toBe(hash(Buffer.from(body)));
    const responseEvidence = JSON.parse(
      decrypt(fs.readFileSync(`${collector.directory}/response-1.enc`), key)
    );
    expect(responseEvidence.headers['set-cookie']).toBe(SECRET);
    const events = fs.readFileSync(`${collector.directory}/events.jsonl`, 'utf8');
    for (const sensitive of [
      ORDER,
      TOKEN,
      SECRET,
      'owner@example.test',
      'A123456789',
      'unverified-signature',
    ]) {
      expect(events).not.toContain(sensitive);
      expect(bytes.includes(Buffer.from(sensitive))).toBe(false);
    }
    for (const name of fs.readdirSync(collector.directory)) {
      expect(fs.statSync(path.join(collector.directory, name)).mode & 0o077).toBe(0);
    }
    expect(fs.statSync(summary.resultFile).mode & 0o077).toBe(0);
    expect(fs.statSync(collector.directory).mode & 0o077).toBe(0);
  });

  test('动态令牌与请求正文在派发前已密封，即使传输失败仍可核对', async () => {
    transport.request.mockImplementationOnce(input => {
      const bytes = fs.readFileSync(`${collector.directory}/request-1.enc`);
      const evidence = JSON.parse(decrypt(bytes, key));
      expect(evidence).toMatchObject({
        url: ACTION,
        method: 'POST',
        headers: { 'x-aos-stk': SECRET },
        body: '',
        observedAt: expect.any(String),
      });
      expect(input.headers['x-aos-stk']).toBe(SECRET);
      expect(bytes.includes(Buffer.from(SECRET))).toBe(false);
      expect(fs.statSync(`${collector.directory}/request-1.enc`).mode & 0o077).toBe(0);
      return Promise.reject(
        Object.assign(new Error('PROXY_CONNECTION_FAILED'), { code: 'PROXY_CONNECTION_FAILED' })
      );
    });
    await expect(
      collector.request(ACTION, 'POST', { 'x-aos-stk': SECRET }, '')
    ).rejects.toMatchObject({ code: 'PROXY_CONNECTION_FAILED' });
    expect(fs.existsSync(`${collector.directory}/response-1.enc`)).toBe(false);
    expect(fs.existsSync(`${root}/private/results`)).toBe(false);
  });
});

test('仅显式登录引导允许官方精确cn/go/account GET', () => {
  const value = 'https://www.apple.com.cn/cn/shop/go/account';
  expect(validateReadUrl(value, 'GET', true).href).toBe(value);
  expect(() => validateReadUrl(value, 'GET')).toThrow('READ_DESTINATION_DENIED');
  expect(() => validateReadUrl(value, 'POST', true)).toThrow('READ_DESTINATION_DENIED');
});

test.each([
  'https://www.apple.com.cn/cn/shop/go/account?next=synthetic',
  'https://www.apple.com.cn/cn/shop/go/account?',
  'https://www.apple.com.cn/cn/shop/go/account#fragment',
  'https://www.apple.com.cn/cn/shop/go/account#',
  'https://www.apple.com.cn/cn/shop/go/account/',
  'https://www.apple.com.cn/cn/shop/go/orders',
  'https://www.apple.com.cn/cn/shop/goto/account',
  'https://secure6.www.apple.com.cn/cn/shop/go/account',
])('登录引导仍拒绝其他cn/go路径和查询：%s', value => {
  expect(() => validateReadUrl(value, 'GET', true)).toThrow('READ_DESTINATION_DENIED');
});

test.each(['secure', 'secure7', 'secure12'])(
  '仅显式登录引导允许官方数字分片账户首页GET：%s',
  host => {
    const value = `https://${host}.www.apple.com.cn/shop/account/home`;
    expect(validateReadUrl(value, 'GET', true).href).toBe(value);
    expect(() => validateReadUrl(value, 'GET')).toThrow('READ_DESTINATION_DENIED');
    expect(() => validateReadUrl(value, 'POST', true)).toThrow('READ_DESTINATION_DENIED');
  }
);

test.each(['/shop/signIn', '/shop/signIn/account'])(
  '精确登录文档GET仅在显式bootstrap开放：%s',
  pathname => {
    const value = `https://secure7.www.apple.com.cn${pathname}?r=synthetic-server-value`;
    expect(validateReadUrl(value, 'GET', true).href).toBe(value);
    expect(() => validateReadUrl(value, 'GET')).toThrow('READ_DESTINATION_DENIED');
    expect(() => validateReadUrl(value, 'POST', true)).toThrow('READ_DESTINATION_DENIED');
    expect(() => validateReadUrl(value + '#', 'GET', true)).toThrow('READ_DESTINATION_DENIED');
    expect(() => validateReadUrl(value + '#fragment', 'GET', true)).toThrow(
      'READ_DESTINATION_DENIED'
    );
  }
);

test.each([
  'https://secure7.www.apple.com.cn/shop/signIn/',
  'https://secure7.www.apple.com.cn/shop/signIn/other',
  'https://www.apple.com.cn/shop/signIn',
  'https://securex.www.apple.com.cn/shop/signIn',
])('显式bootstrap也拒绝其他登录子路径和host：%s', value => {
  expect(() => validateReadUrl(value, 'GET', true)).toThrow('READ_DESTINATION_DENIED');
});

test.each([
  'https://secure.www.apple.com.cn/shop/account/home?next=synthetic',
  'https://secure.www.apple.com.cn/shop/account/home?',
  'https://secure.www.apple.com.cn/shop/account/home#fragment',
  'https://secure.www.apple.com.cn/shop/account/home#',
  'https://secure.www.apple.com.cn/shop/account/home/',
  'https://secure.www.apple.com.cn/shop/account/orders',
  'https://securex.www.apple.com.cn/shop/account/home',
  'https://www.apple.com.cn/shop/account/home',
  'https://secure7.www.apple.com.cn/shop/account/home?next=synthetic',
  'https://secure7.www.apple.com.cn/shop/account/home?',
  'https://secure7.www.apple.com.cn/shop/account/home#fragment',
  'https://secure7.www.apple.com.cn/shop/account/home#',
  'https://secure7.www.apple.com.cn/shop/account/home/',
  'https://secure7.www.apple.com.cn/shop/account/orders',
])('登录引导仍拒绝账户首页查询及其他host/path：%s', value => {
  expect(() => validateReadUrl(value, 'GET', true)).toThrow('READ_DESTINATION_DENIED');
});

describe('负数量退货详情与收据总数的边界', () => {
  const returnedDetail = () => {
    const model = structuredClone(require('./fixtures/officialReturnQuantity.json'));
    model.orderDetail.orderHeader.d.invoiceUrl = RECEIPT;
    return JSON.stringify(model);
  };
  test('状态采集保留解释与加密原文，不请求收据或生成SN', async () => {
    collector.collectReceipt = false;
    const body = returnedDetail();
    queue(response(body));
    const summary = await collector.collect();
    expect(summary.receiptOutcome).toBe('RECEIPT_NOT_REQUESTED');
    expect(transport.request).toHaveBeenCalledTimes(1);
    const result = readPrivate(summary.resultFile);
    expect(result.products.map(item => item.quantity)).toEqual([1, 1]);
    expect(result.products.map(item => item.rawQuantity)).toEqual([-1, -1]);
    expect(result.products.every(item => item.serialNumbers === undefined)).toBe(true);
    expect(result.source.sha256).toBe(hash(Buffer.from(body)));
  });
  test('显式收据流程仍按完整SN及自身正数量验证总数', async () => {
    queue(response(returnedDetail()), response(receipt()));
    const summary = await collector.collect();
    expect(summary.receiptOutcome).toBe('RECEIPT_VERIFIED');
    expect(receiptParser.parseOfficialReceipt).toHaveBeenCalledWith(expect.any(String), ORDER, 2);
  });
  test('收据总数与退货详情兼容计数不符时仍不采纳收据', async () => {
    queue(response(returnedDetail()), response(receipt({ serials: ['A123456789'] })));
    const summary = await collector.collect();
    expect(summary.receiptOutcome).not.toBe('RECEIPT_VERIFIED');
    expect(fs.existsSync(`${root}/private/http-receipt-11-run-21.json`)).toBe(false);
  });
});
