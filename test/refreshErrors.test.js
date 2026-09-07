const {
  classifyRefreshError,
  sanitizeRefreshError,
} = require('../src/services/crawler/refreshErrors');

describe('订单刷新错误分类与脱敏', () => {
  test.each([
    [541, 'APPLE_541'],
    [429, 'APPLE_429'],
    [441, 'PROXY_441'],
    [407, 'PROXY_407'],
    [517, 'PROXY_517'],
  ])('HTTP %s 映射为 %s', (status, code) => {
    expect(classifyRefreshError({ response: { status } })).toBe(code);
  });

  test('错误摘要隐藏 URL、邮箱和代理授权内容', () => {
    const summary = sanitizeRefreshError({
      message: 'request https://www.apple.com.cn/order/u@example.com proxy-authorization=secret',
    });

    expect(summary).not.toContain('u@example.com');
    expect(summary).not.toContain('secret');
    expect(summary).not.toContain('apple.com.cn');
    expect(summary).toContain('[URL已隐藏]');
  });
});
