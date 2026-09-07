const {
  parseOrderIdentity,
  classifyAttemptError,
  createAggregate,
  serializeAggregate,
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
});
