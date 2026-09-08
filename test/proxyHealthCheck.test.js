const mockAxiosGet = jest.fn();
const mockAcquire = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('axios', () => ({ get: mockAxiosGet }));
jest.mock('../src/utils/logger', () => mockLogger);
jest.mock('../src/utils/config', () => ({
  config: {
    crawler: { userAgent: 'jest-agent', timeout: 1000 },
  },
}));
jest.mock('../src/services/crawler/crawlerRateLimiter', () => ({ acquire: mockAcquire }));

const {
  validateProxyProviderCandidate,
} = require('../src/services/crawler/proxy/proxyHealthCheck');

function createCandidate(providerName = 'kdl_private') {
  const proxy = {
    host: 'proxy.example',
    port: 8080,
    auth: { username: 'secret-user', password: 'secret-password' },
  };
  return {
    getStatus: jest.fn(() => ({ provider: providerName })),
    getNextProxy: jest.fn(() => proxy),
    refresh: jest.fn(),
    recordProxySuccess: jest.fn(),
    recordProxyFailure: jest.fn(),
    markProxyAsBad: jest.fn(),
    proxy,
  };
}

describe('候选代理 Provider 连通性检查', () => {
  beforeEach(() => jest.clearAllMocks());

  test('请求 Apple 前获取全局限流时隙且日志不泄漏鉴权', async () => {
    const candidate = createCandidate();
    mockAcquire.mockResolvedValue();
    mockAxiosGet.mockResolvedValue({ status: 200 });

    await expect(validateProxyProviderCandidate(candidate)).resolves.toMatchObject({
      provider: 'kdl_private',
      statusCode: 200,
    });

    expect(mockAcquire).toHaveBeenCalledTimes(1);
    expect(candidate.recordProxySuccess).toHaveBeenCalledWith(candidate.proxy);
    const logs = JSON.stringify(mockLogger.info.mock.calls);
    expect(logs).not.toContain('secret-user');
    expect(logs).not.toContain('secret-password');
  });

  test('鉴权失败返回稳定错误且不重试', async () => {
    const candidate = createCandidate();
    const upstreamError = new Error('proxy secret-user secret-password');
    upstreamError.response = { status: 407 };
    mockAcquire.mockResolvedValue();
    mockAxiosGet.mockRejectedValue(upstreamError);

    await expect(validateProxyProviderCandidate(candidate)).rejects.toMatchObject({
      code: 'PROXY_407',
      message: '候选代理 Provider 连通性检查失败',
    });
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('secret-user');
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('secret-password');
  });

  test('网帆未知数字状态按通用传输错误重试而不套用快代理语义', async () => {
    const candidate = createCandidate('fanproxy_tunnel');
    const upstreamError = new Error('vendor-specific');
    upstreamError.response = { status: 441 };
    mockAcquire.mockResolvedValue();
    mockAxiosGet.mockRejectedValue(upstreamError);

    await expect(validateProxyProviderCandidate(candidate)).rejects.toMatchObject({
      code: 'PROXY_TRANSPORT',
    });

    expect(mockAxiosGet).toHaveBeenCalledTimes(3);
    expect(candidate.recordProxyFailure).toHaveBeenCalledTimes(3);
  });
});
