/* eslint-disable no-magic-numbers -- 明确测试输入、时效和权限边界。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const support = require('../src/services/officialOrderSupport');

function sample() {
  return {
    id: 11,
    orderNumber: 'W1234567890',
    email: 'account@example.test',
    password: 'synthetic',
    url: 'https://www.apple.com.cn/shop/order/list/W1234567890/contact%40example.test',
  };
}

describe('服务器官网采集输入、身份和隐私边界', () => {
  let directory;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'official-order-test-'));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('Apple ID 与联系邮箱可不同，但三处订单身份必须一致', () => {
    expect(
      support.validateSample({
        ...sample(),
        url: sample().url.replace('shop/order/list', 'xc/cn/vieworder'),
      }).id
    ).toBe(11);
    expect(support.validateSample(sample())).toMatchObject({
      accountHash: support.hash('account@example.test'),
    });
    expect(() => support.validateSample({ ...sample(), orderNumber: 'W9999999999' })).toThrow(
      'LINK_IDENTITY_MISMATCH'
    );
    expect(() =>
      support.validateSample({ ...sample(), accountHash: support.hash('another') })
    ).toThrow('ACCOUNT_MISMATCH');
    expect(() => support.validateSample({ ...sample(), snapshotPasswordMatches: false })).toThrow(
      'CREDENTIAL_SNAPSHOT_MISMATCH'
    );
  });
  test.each([
    null,
    {},
    { ...sample(), id: -1 },
    { ...sample(), email: 'x' },
    { ...sample(), password: '' },
  ])('拒绝不完整输入 %#', value => {
    expect(() => support.validateSample(value)).toThrow('INPUT_INVALID');
  });
  test.each([
    'http://www.apple.com.cn/shop/order/list',
    'https://apple.com.cn.evil.test/',
    'https://apple.com.cn@evil.test/',
    'file:///etc/passwd',
    'https://www.apple.com.cn:8443/',
    'bad',
  ])('每个重定向和子请求均拒绝非官方目的地 %s', url => {
    expect(() => support.permittedUrl(url)).toThrow('DESTINATION_DENIED');
  });
  test('官方资源域名及多商品不同详情参数可用，但跨订单详情不可用', () => {
    expect(support.permittedUrl('https://store.storeimages.cdn-apple.com/image')).toBeInstanceOf(
      URL
    );
    expect(
      support.detailUrl(
        '/shop/order/detail/123/W1234567890?item=1',
        'secure6.www.apple.com.cn',
        'W1234567890'
      )
    ).toContain('?item=1');
    expect(() =>
      support.detailUrl(
        '/shop/order/detail/123/W9999999999',
        'secure6.www.apple.com.cn',
        'W1234567890'
      )
    ).toThrow('DETAIL_DESTINATION_INVALID');
    expect(() =>
      support.detailUrl(
        'https://www.apple.com.cn/shop/order/detail/123/W1234567890',
        'secure6.www.apple.com.cn',
        'W1234567890'
      )
    ).toThrow('DETAIL_DESTINATION_INVALID');
  });
  test('访客令牌、邮箱、订单号和 query 不进入普通来源路径', () => {
    const token = 'A'.repeat(80);
    const safe = support.safePath(`/shop/orderx/guestx/W1234567890/${token}?secret=value`);
    expect(safe).toBe('/shop/orderx/guestx/[ORDER]/[TOKEN]');
    expect(support.safePath('/shop/order/list/W1234567890/a%40b.test')).toBe(
      '/shop/order/list/[ORDER]/[EMAIL]'
    );
  });
  test('私有文件原子替换、权限及符号链接校验', () => {
    const file = path.join(directory, 'private/result.json');
    support.writePrivate(file, '{"version":1}');
    support.writePrivate(file, '{"version":2}');
    expect(support.readPrivate(file)).toEqual({ version: 2 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const link = path.join(directory, 'link');
    fs.symlinkSync(file, link);
    expect(() => support.readPrivate(link)).toThrow('PRIVATE_FILE_PERMISSIONS');
    fs.chmodSync(file, 0o644);
    expect(() => support.readPrivate(file)).toThrow('PRIVATE_FILE_PERMISSIONS');
  });
  test('原始证据加密可回读，错误密钥、篡改和短包均拒绝', () => {
    const key = crypto.randomBytes(32);
    const encrypted = support.encrypt({ secret: 'test-only' }, key);
    expect(encrypted.includes(Buffer.from('test-only'))).toBe(false);
    expect(JSON.parse(support.decrypt(encrypted, key))).toEqual({ secret: 'test-only' });
    expect(() => support.decrypt(encrypted, crypto.randomBytes(32))).toThrow(
      'ENCRYPTED_STATE_INVALID'
    );
    encrypted[30] ^= 1;
    expect(() => support.decrypt(encrypted, key)).toThrow('ENCRYPTED_STATE_INVALID');
    expect(() => support.decrypt(Buffer.alloc(2), key)).toThrow('ENCRYPTED_STATE_INVALID');
    expect(() => support.encrypt({}, Buffer.alloc(2))).toThrow('KEY_INVALID');
  });
  test('空响应正文的 AES-GCM 包仅含 IV 和认证标签，仍可完整回读', () => {
    const key = crypto.randomBytes(32);
    const encrypted = support.encrypt(Buffer.alloc(0), key);
    expect(encrypted).toHaveLength(28);
    expect(support.decrypt(encrypted, key)).toEqual(Buffer.alloc(0));
  });
  test.each(['tag', 'iv', 'key', 'short-key', 'missing-payload'])(
    '最短密文仍强制认证，拒绝 %s',
    kind => {
      let key = crypto.randomBytes(32);
      let encrypted = support.encrypt(Buffer.alloc(0), key);
      if (kind === 'tag') encrypted[12] ^= 1;
      if (kind === 'iv') encrypted[0] ^= 1;
      if (kind === 'key') key = crypto.randomBytes(32);
      if (kind === 'short-key') key = key.subarray(0, 31);
      if (kind === 'missing-payload')
        encrypted = support.encrypt(Buffer.from('nonempty'), key).subarray(0, 28);
      expect(() => support.decrypt(encrypted, key)).toThrow('ENCRYPTED_STATE_INVALID');
    }
  );
  test.each([0, 11, 12, 27])('空正文包截断到 %i 字节必须拒绝', length => {
    const key = crypto.randomBytes(32);
    const encrypted = support.encrypt(Buffer.alloc(0), key).subarray(0, length);
    expect(() => support.decrypt(encrypted, key)).toThrow('ENCRYPTED_STATE_INVALID');
  });
  test('会话账号绑定和 105 分钟时效，恢复不会默默接受其他域 Cookie', () => {
    const now = Date.now();
    const state = {
      accountHash: 'a',
      createdAt: new Date(now).toISOString(),
      cookies: [{ domain: '.apple.com.cn' }],
    };
    expect(support.validateSession(state, 'a', now)).toHaveLength(1);
    expect(() => support.validateSession(state, 'b', now)).toThrow('SESSION_IDENTITY_MISMATCH');
    expect(support.validateSession(state, 'a', now + 6300000)).toHaveLength(1);
    expect(() => support.validateSession(state, 'a', now + 6300001)).toThrow('SESSION_EXPIRED');
    expect(() =>
      support.validateSession({ ...state, cookies: [{ domain: 'evil.test' }] }, 'a', now)
    ).toThrow('DESTINATION_DENIED');
    expect(() => support.validateSession({ ...state, cookies: null }, 'a', now)).toThrow(
      'SESSION_INVALID'
    );
  });
  test('仅旧导航取消可忽略，真实协议失败不会伪装成功', () => {
    expect(
      support.isCanceledInterception({
        method: 'Fetch.continueRequest',
        detail: 'Invalid InterceptionId.',
      })
    ).toBe(true);
    expect(
      support.isCanceledInterception({
        method: 'Fetch.continueRequest',
        detail: 'Session with given id not found',
      })
    ).toBe(true);
    expect(
      support.isCanceledInterception({ method: 'Fetch.continueRequest', detail: 'Unknown method' })
    ).toBe(false);
    expect(
      support.isCanceledInterception({ method: 'Network.enable', detail: 'Invalid RequestId' })
    ).toBe(false);
  });
});

test('IPRoyal 密码会话参与摘要，旧供应商保护摘要保持不变', () => {
  const proxy = { host: 'test', port: 12321, username: 'user', password: 'pass' };
  expect(support.proxyFingerprint(proxy)).toBe(support.hash('test:12321:user'));
  expect(support.proxyFingerprint({ ...proxy, provider: 'iproyal' })).toBe(
    support.hash('["test",12321,"user","pass"]')
  );
  expect(support.proxyFingerprint({ ...proxy, provider: 'iproyal', password: 'other' })).not.toBe(
    support.proxyFingerprint({ ...proxy, provider: 'iproyal' })
  );
  expect(support.proxyLeaseWindowMs({ provider: 'iproyal' })).toBe(86190000);
  expect(support.proxyLeaseWindowMs({ provider: 'iproyal' }, true)).toBe(86370000);
  expect(support.proxyLeaseWindowMs({})).toBe(390000);
  expect(() => support.proxyLeaseWindowMs({ provider: 'unknown' })).toThrow(
    'PROXY_PROVIDER_INVALID'
  );
});

test('收据短令牌也脱敏，不以字符长度决定能否进入普通日志', () => {
  const { safePath } = require('../src/services/officialOrderSupport');
  expect(safePath('/shop/order/print/invoice/123/Abc?token=secret')).toBe(
    '/shop/order/print/invoice/[INVOICE]/[TOKEN]'
  );
});
