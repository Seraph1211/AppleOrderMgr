const { EventEmitter } = require('events');
const { requestOnce } = require('../src/services/inventoryValidationClient');

function harness(response, tunnelStatus = 200) {
  const agent = new EventEmitter();
  agent.destroy = jest.fn();
  const gate = { reserve: jest.fn().mockResolvedValue({ id: 'test-id' }), finish: jest.fn() };
  const request = jest.fn(() => {
    agent.emit('proxyConnect', { statusCode: tunnelStatus });
    return Promise.resolve(response);
  });
  return {
    agent,
    gate,
    request,
    options: {
      purpose: 'connect',
      context: {},
      proxy: { label: 'test', url: 'http://user:secret@proxy.test:80' },
      gate,
      request,
      createAgent: () => Promise.resolve(agent),
    },
  };
}

describe('库存探测 HTTP 边界', () => {
  test('响应200但读取失败不能算成功', async () => {
    const h = harness({});
    h.request.mockRejectedValue(
      Object.assign(new Error('secret stream aborted'), {
        code: 'ERR_BAD_RESPONSE',
        response: { status: 200 },
      })
    );
    expect(await requestOnce(h.options)).toMatchObject({
      outcome: 'RESPONSE_READ_FAILED',
      status: 200,
      summary: { transportCode: 'ERR_BAD_RESPONSE', transportReason: 'STREAM_INTERRUPTED' },
    });
  });
  test('无效库存保存结构证据而非原始敏感正文', async () => {
    const h = harness({
      status: 200,
      headers: {},
      data: '{"head":{"status":400},"body":{"error":"private diagnostic","stores":[]}}',
    });
    h.options.purpose = 'inventory';
    h.options.context = { skus: ['TEST1CH/A'], location: '610000' };
    const result = await requestOnce(h.options);
    expect(result).toMatchObject({
      outcome: 'INVALID_RESPONSE',
      summary: {
        invalidReason: 'INVALID_STORES',
        headStatus: 400,
        hasStores: true,
        storeCount: 0,
        format: 'json',
      },
    });
    expect(result.summary.bodyHash).toHaveLength(64);
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
    expect(result.evidence).toBeUndefined();
  });

  test('出口仅保留摘要，默认启用 TLS 校验、不跟随跳转、不直连、不重试', async () => {
    const h = harness({ status: 200, headers: {}, data: '{"ip":"192.0.2.1"}' });
    const result = await requestOnce(h.options);
    expect(result.outcome).toBe('PROXY_CONNECTED');
    expect(JSON.stringify(result)).not.toMatch(/192\.0\.2\.1|secret|user/);
    expect(result.summary.egressHash).toHaveLength(64);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0][1]).toMatchObject({
      proxy: false,
      maxRedirects: 0,
      timeout: 20000,
      httpsAgent: h.agent,
    });
    expect(h.request.mock.calls[0][1].rejectUnauthorized).not.toBe(false);
    expect(h.agent.destroy).toHaveBeenCalledTimes(1);
  });
  test.each([416, 429, 541, 407])('CONNECT %d 不冒充 Apple 响应', async status => {
    const h = harness({ status, headers: {}, data: '' }, status);
    const result = await requestOnce(h.options);
    expect(result.outcome).toBe(status === 407 ? 'PROXY_AUTH_FAILED' : 'PROXY_CONNECT_REJECTED');
    expect(result.summary.responseSource).toBe('proxy_connect');
    expect(result.evidence).toBeUndefined();
    expect(h.gate.finish).toHaveBeenCalledTimes(1);
  });
  test.each([502, 503, 504])('CONNECT %d 仅作为临时代理故障，不锁死供应商', async status => {
    const h = harness({ status, headers: {}, data: '' }, status);
    expect(await requestOnce(h.options)).toMatchObject({
      outcome: 'PROXY_TUNNEL_UNAVAILABLE',
      summary: { responseSource: 'proxy_connect', tunnelStatus: status },
    });
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  test('目标429尊重Retry-After且没有自动换出口', async () => {
    const h = harness({ status: 429, headers: { 'retry-after': '900' }, data: '' });
    const result = await requestOnce(h.options);
    expect(result).toMatchObject({ outcome: 'TARGET_RATE_LIMITED', retryMs: 900000 });
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  test('预算拒绝不产生请求', async () => {
    const h = harness({});
    h.gate.reserve.mockResolvedValue({ blocked: 'REQUEST_BUDGET_EXHAUSTED' });
    expect((await requestOnce(h.options)).outcome).toBe('REQUEST_BUDGET_EXHAUSTED');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.gate.finish).not.toHaveBeenCalled();
    expect(h.agent.destroy).toHaveBeenCalled();
  });
  test('未到期租约不轮询或发送请求', async () => {
    const h = harness({});
    h.gate.reserve.mockResolvedValue({ waitMs: 40000 });
    expect((await requestOnce(h.options)).outcome).toBe('REQUEST_IN_FLIGHT');
    expect(h.request).not.toHaveBeenCalled();
  });
  test('异常文本包含凭据也不得出现在返回结果', async () => {
    const h = harness({});
    h.request.mockRejectedValue(
      Object.assign(new Error('secret password'), { code: 'ECONNABORTED' })
    );
    const result = await requestOnce(h.options);
    expect(result.outcome).toBe('REQUEST_TIMEOUT');
    expect(JSON.stringify(result)).not.toMatch(/secret|password/);
    expect(h.gate.finish).toHaveBeenCalledTimes(1);
  });
  test('存储失败不能返回成功，清理连接且脱敏', async () => {
    const h = harness({ status: 200, headers: {}, data: '{"ip":"192.0.2.1"}' });
    h.gate.finish.mockRejectedValue(new Error('secret DB password'));
    await expect(requestOnce(h.options)).rejects.toThrow('VALIDATION_PERSISTENCE_FAILED');
    expect(h.agent.destroy).toHaveBeenCalled();
  });
  test('200伪JSON或HTML挑战不作为可用数据', async () => {
    const h = harness({ status: 200, headers: {}, data: '<html>challenge</html>' });
    expect((await requestOnce(h.options)).outcome).toBe('INVALID_RESPONSE');
  });
  test('目录原始公开HTML作为证据保存', async () => {
    const h = harness({ status: 200, headers: {}, data: '<html>Apple iPhone</html>' });
    h.options.purpose = 'catalog';
    h.options.context = { path: '/shop/buy-iphone' };
    expect(await requestOnce(h.options)).toMatchObject({
      outcome: 'CATALOG_RECEIVED',
      evidence: '<html>Apple iPhone</html>',
    });
  });
  test('未知SKU状态只记为部分响应', async () => {
    const data = JSON.stringify({
      body: { stores: [{ storeNumber: 'R001', storeName: '合成店', partsAvailability: {} }] },
    });
    const h = harness({ status: 200, headers: {}, data });
    h.options.purpose = 'inventory';
    h.options.context = { skus: ['TEST1CH/A'], location: '100000' };
    expect(await requestOnce(h.options)).toMatchObject({
      outcome: 'PARTIAL_RESPONSE',
      summary: { rows: 1, unknown: 1, valid: 0 },
    });
  });
});
