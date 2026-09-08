const {
  parseOrderIdentity,
  classifyAttemptError,
  createAggregate,
  serializeAggregate,
  resolveProviderNames,
} = require('../scripts/runProxyAbTest');

describe('代理 A/B 只读诊断脚本', () => {
  test('只接受 Apple 中国访客订单 URL 并提取身份', () => {
    expect(
      parseOrderIdentity('https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test%40example.com')
    ).toEqual({ orderNumber: 'W1234567890', appleId: 'test@example.com' });
    expect(() =>
      parseOrderIdentity('https://example.com/xc/cn/vieworder/W1234567890/test@example.com')
    ).toThrow('订单 URL 格式无效');
  });

  test('错误统计不包含上游异常消息', () => {
    const error = new Error('secret credential');
    error.response = { status: 541 };

    expect(classifyAttemptError(error)).toBe('HTTP_541');
    expect(classifyAttemptError({ code: 'ERR_BAD_REQUEST', response: { status: 407 } })).toBe(
      'HTTP_407'
    );
    expect(classifyAttemptError({ code: 'ERR_BAD_RESPONSE', response: { status: 200 } })).toBe(
      'STREAM_INTERRUPTED'
    );
    expect(classifyAttemptError(new Error('secret credential'))).toBe('TRANSPORT');
  });

  test('输出聚合结果时删除逐单布尔数组', () => {
    const aggregate = createAggregate('kdl_tunnel', 2);
    aggregate.success = 1;
    aggregate.results[0] = true;

    expect(serializeAggregate(aggregate)).toMatchObject({
      provider: 'kdl_tunnel',
      total: 2,
      success: 1,
      successRate: 50,
    });
    expect(serializeAggregate(aggregate)).not.toHaveProperty('results');
  });

  test('可显式仅选择已配置的网帆 Provider', () => {
    expect(
      resolveProviderNames({
        providers: ['fanproxy_tunnel', 'fanproxy_tunnel'],
        fanproxyTunnel: { hosts: ['proxy.example.com'] },
      })
    ).toEqual(['fanproxy_tunnel']);
    expect(() => resolveProviderNames({ providers: [] })).toThrow('Provider 选择不能为空');
    expect(() => resolveProviderNames({ providers: ['fanproxy_tunnel'] })).toThrow(
      '网帆隧道运行配置缺失'
    );
    expect(() => resolveProviderNames({ providers: ['unknown'] })).toThrow(
      'Provider 选择包含不支持的值'
    );
  });

  test('亦优 HTTP 需要独立运行配置', () => {
    expect(() => resolveProviderNames({ providers: ['yiyou_http'] })).toThrow(
      '亦优 HTTP 运行配置缺失'
    );
    expect(
      resolveProviderNames({
        providers: ['yiyou_http'],
        yiyouHttp: { apiUrl: 'https://api.yiyouip.com/test' },
      })
    ).toEqual(['yiyou_http']);
  });
});
