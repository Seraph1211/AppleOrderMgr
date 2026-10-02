const { parseProviderEndpoint, acquireProxy } = require('../src/services/inventoryValidationProxy');
describe('既有短效代理单端点提取', () => {
  test.each([
    '{"error":"expired"}',
    '',
    '127.0.0.1:0 a b',
    'example.com:80 a b',
    '127.0.0.1:8080 a b extra',
  ])('拒绝错误或非预期格式 %s', text => {
    expect(() => parseProviderEndpoint(text)).toThrow('INVALID_PROVIDER_ENDPOINT');
  });
  test('端点正确编码凭据', () => {
    expect(parseProviderEndpoint('192.0.2.1:8080 user password')).toBe(
      'http://user:password@192.0.2.1:8080'
    );
  });
  test('强制只提取一个，不跟随跳转，记录仅含摘要', async () => {
    const gate = { reserve: jest.fn().mockResolvedValue({ id: 'a' }), finish: jest.fn() };
    const request = jest
      .fn()
      .mockResolvedValue({ status: 200, data: '192.0.2.1:8080 user password' });
    const result = await acquireProxy({
      apiUrl: 'https://api.yiyouip.com/index.php?num=100&order_id=synthetic',
      gate,
      request,
    });
    expect(new URL(request.mock.calls[0][0]).searchParams.get('num')).toBe('1');
    expect(request.mock.calls[0][1]).toMatchObject({ proxy: false, maxRedirects: 0 });
    expect(result.label).toBe('yiyou-validation');
    expect(JSON.stringify(gate.finish.mock.calls)).not.toMatch(/password|192\.0\.2\.1/);
  });
  test('拒绝任意供应商地址；预算拒绝或请求失败不自动重试', async () => {
    const gate = { reserve: jest.fn().mockResolvedValue({ blocked: 'BUDGET' }), finish: jest.fn() };
    const request = jest.fn();
    await expect(acquireProxy({ apiUrl: 'https://evil.test/', gate, request })).rejects.toThrow(
      'PROVIDER_UNAVAILABLE'
    );
    await expect(
      acquireProxy({ apiUrl: 'https://api.yiyouip.com/index.php', gate, request })
    ).rejects.toThrow('PROVIDER_UNAVAILABLE');
    expect(request).not.toHaveBeenCalled();
    gate.reserve.mockResolvedValue({ id: 'a' });
    request.mockRejectedValue(new Error('secret'));
    await expect(
      acquireProxy({ apiUrl: 'https://api.yiyouip.com/index.php', gate, request })
    ).rejects.toThrow('PROVIDER_UNAVAILABLE');
    expect(request).toHaveBeenCalledTimes(1);
    expect(gate.finish).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'PROVIDER_FAILED' })
    );
  });
});
