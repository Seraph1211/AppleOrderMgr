const { classifyInventoryRedirect } = require('../src/services/inventoryRedirectPolicy');

const request = { purpose: 'inventory', status: 307, tunnelStatus: 200 };

describe('库存未跟随307分类', () => {
  test.each([
    undefined,
    null,
    '',
    '/shop/retail/pickup-message?parts.0=TEST1CH%2FA&location=100000',
    'https://www.apple.com.cn:443/shop/retail/pickup-message?unknown=private',
    '/unknown-route?unknown=private',
    '?parts.0=OTHERCH%2FA&location=200000',
  ])('不消费目标，仅允许稍后有限重试原URL %#', location => {
    const result = classifyInventoryRedirect({ ...request, location });
    expect(result).toMatchObject({
      outcome: 'TARGET_REJECTED',
      summary: { redirectDecision: 'RETRY_ORIGINAL', targetRejectReason: 'UNFOLLOWED_REDIRECT' },
    });
    expect(result.nextUrl).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private');
    if (typeof location === 'string' && location)
      expect(result.summary.redirectLocationHash).toMatch(/^[a-f0-9]{64}$/);
  });
  test.each([
    'https://evil.test/private',
    '//evil.test/private',
    'https://www.apple.com.cn.evil.test/',
    'http://www.apple.com.cn/shop/retail/pickup-message',
    'javascript:private',
    'ftp://www.apple.com.cn/file',
    'https://user:private@www.apple.com.cn/',
    'https://www.apple.com.cn:8443/',
    '/same-origin#private',
    '/same-origin#',
    '/path\r\nX-Private:secret',
    '/path%0aother',
    '/path%ZZ',
    'https://[invalid',
    '/challenge',
    '/Captcha?token=private',
    '/auth/login',
    '/%63hallenge',
    '/other?captcha_token=private',
    '/other?redirect=%2Fsignin',
    ' ',
    ['https://www.apple.com.cn/'],
    { private: 'secret' },
  ])('危险或非法Location保持人工处理 %#', location => {
    const result = classifyInventoryRedirect({ ...request, location });
    expect(result).toMatchObject({
      outcome: 'REDIRECT_BLOCKED',
      summary: { redirectDecision: 'MANUAL_REVIEW' },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|evil\.test/);
    expect(result.nextUrl).toBeUndefined();
  });
  test.each([
    { purpose: 'catalog' },
    { purpose: 'egress' },
    { status: 301 },
    { status: 302 },
    { status: 308 },
    { tunnelStatus: undefined },
    { tunnelStatus: 407 },
  ])('用途或目标来源未确认不放宽 %#', patch => {
    expect(classifyInventoryRedirect({ ...request, ...patch }).outcome).toBe('REDIRECT_BLOCKED');
  });
  test('过长Location不输出原值', () => {
    const result = classifyInventoryRedirect({ ...request, location: '/' + 'a'.repeat(8192) });
    expect(result.outcome).toBe('REDIRECT_BLOCKED');
    expect(result.summary.redirectLocationHash).toHaveLength(64);
    expect(JSON.stringify(result).length).toBeLessThan(400);
  });
});
