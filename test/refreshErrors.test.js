const {
  classifyRefreshError,
  sanitizeRefreshError,
} = require('../src/services/crawler/refreshErrors');

describe('订单刷新错误分类与脱敏', () => {
  test.each([
    [{ response: { status: 424 }, code: 'ERR_BAD_RESPONSE' }, 'HTTP_424'],
    [{ response: { status: 200 }, code: 'ERR_BAD_RESPONSE' }, 'RESPONSE_STREAM'],
    [{ eventType: 'parse' }, 'PARSE'],
    [{ eventType: 'order_identity' }, 'IDENTITY'],
    [{ eventType: 'concurrency' }, 'CONCURRENCY'],
  ])('HTTP、响应中断、解析和身份错误分开记录 %j', (error, expected) => {
    expect(classifyRefreshError(error)).toBe(expected);
  });
  test.each([
    [541, 'APPLE_541'],
    [429, 'APPLE_429'],
    [441, 'PROXY_441'],
    [407, 'PROXY_407'],
    [517, 'PROXY_517'],
  ])('HTTP %s 映射为 %s', (status, code) => {
    expect(classifyRefreshError({ response: { status } })).toBe(code);
  });

  test('快代理专属状态码不会套用到网帆 Provider', () => {
    expect(classifyRefreshError({ httpStatus: 441, proxyProvider: 'kdl_tunnel' })).toBe(
      'PROXY_441'
    );
    expect(classifyRefreshError({ httpStatus: 517, proxyProvider: 'kdl_private' })).toBe(
      'PROXY_517'
    );
    expect(
      classifyRefreshError({
        httpStatus: 441,
        proxyProvider: 'fanproxy_tunnel',
        eventType: 'proxy',
      })
    ).toBe('HTTP_441');
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
