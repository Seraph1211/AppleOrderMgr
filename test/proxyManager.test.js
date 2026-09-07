const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../src/utils/logger', () => mockLogger);

const KdlPrivateProvider = require('../src/services/crawler/proxy/kdlPrivateProvider');
const { createProxyProvider } = require('../src/services/crawler/proxy/proxyProvider');
const proxyManagerModule = require('../src/utils/proxyManager');

const { ProxyManager, maskProxyString } = proxyManagerModule;

function createProvider(name, options = {}) {
  return {
    initialize: jest.fn(() =>
      options.initializeError ? Promise.reject(options.initializeError) : Promise.resolve()
    ),
    refresh: jest.fn(),
    getNextProxy: jest.fn(() => ({ host: `${name}.example`, port: 8080 })),
    recordProxyFailure: jest.fn(() => false),
    recordProxySuccess: jest.fn(),
    markProxyAsBad: jest.fn(),
    getStatus: jest.fn(() => ({
      provider: name,
      enabled: true,
      isInitialized: true,
      total: 1,
      available: 1,
      bad: 0,
    })),
  };
}

describe('proxyManager 安全切换与敏感信息保护', () => {
  beforeEach(() => jest.clearAllMocks());

  test('候选 Provider 验证失败时保留原 Provider', async () => {
    const providers = new Map([
      ['kdl_tunnel', createProvider('kdl_tunnel')],
      ['kdl_private', createProvider('kdl_private')],
    ]);
    const manager = new ProxyManager({ enabled: true, provider: 'kdl_tunnel' }, options =>
      providers.get(options.provider)
    );

    await manager.initialize();
    await expect(
      manager.switchProvider('kdl_private', {
        validateCandidate: () => Promise.reject(new Error('candidate failed')),
      })
    ).rejects.toThrow('candidate failed');

    expect(manager.getStatus().activeProvider).toBe('kdl_tunnel');
    expect(manager.getNextProxy().host).toBe('kdl_tunnel.example');
  });

  test('未知 Provider 失败关闭且不调用工厂', async () => {
    const factory = jest.fn();
    const manager = new ProxyManager({ enabled: true, provider: 'kdl_tunnel' }, factory);

    await expect(manager.switchProvider('unknown')).rejects.toThrow('不支持的代理 Provider');
    expect(factory).not.toHaveBeenCalled();
  });

  test('切换操作串行执行并以最后一次请求为准', async () => {
    let running = 0;
    let maxRunning = 0;
    const factory = jest.fn(options => {
      const provider = createProvider(options.provider);
      provider.initialize = jest.fn(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(resolve => setTimeout(resolve, 5));
        running--;
      });
      return provider;
    });
    const manager = new ProxyManager({ enabled: true, provider: 'kdl_tunnel' }, factory);

    await Promise.all([
      manager.switchProvider('kdl_tunnel'),
      manager.switchProvider('kdl_private'),
    ]);

    expect(maxRunning).toBe(1);
    expect(manager.getStatus().activeProvider).toBe('kdl_private');
  });

  test('私密代理无效响应日志不包含用户名和密码', () => {
    const provider = new KdlPrivateProvider({ apiUrl: 'https://proxy.example/api' });
    const responseData = { code: 0, data: { count: 1 } };
    responseData.data['proxy_list'] = '1.2.3.4:8080:test_user:test_password';

    expect(provider.parseProxyResponse(responseData)).toEqual([]);
    const loggedPayload = JSON.stringify(mockLogger.error.mock.calls);
    expect(loggedPayload).not.toContain('test_user');
    expect(loggedPayload).not.toContain('test_password');
    expect(loggedPayload).toContain('proxyListCount');
  });

  test('私密代理兼容 text/plain JSON 响应并保留鉴权', () => {
    const provider = new KdlPrivateProvider({ apiUrl: 'https://proxy.example/api' });
    const responseData = provider.normalizeProxyResponse(
      '{"code":0,"data":{"proxy_list":["1.2.3.4:8080:test_user:test_password"]}}'
    );

    expect(provider.parseProxyResponse(responseData)).toEqual([
      {
        host: '1.2.3.4',
        port: 8080,
        auth: { username: 'test_user', password: 'test_password' },
        provider: 'kdl_private',
      },
    ]);
  });

  test('私密代理拒绝无法解析的文本响应', () => {
    const provider = new KdlPrivateProvider({ apiUrl: 'https://proxy.example/api' });

    expect(() => provider.normalizeProxyResponse('<html>invalid</html>')).toThrow(
      '代理 API 响应格式无效'
    );
  });

  test('私密代理刷新不清空仍在冷却期的坏 IP', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const provider = new KdlPrivateProvider({
      apiUrl: 'https://proxy.example/api',
      badProxyTimeout: 5000,
    });
    provider.proxies = [provider.parseProxyString('1.2.3.4:8080:user:password')];
    provider.markProxyAsBad(provider.proxies[0]);

    expect(provider.getNextProxy()).toBeNull();
    provider.proxies = [provider.parseProxyString('1.2.3.4:8080:user:password')];
    expect(provider.getNextProxy()).toBeNull();

    now.mockReturnValue(6001);
    expect(provider.getNextProxy()).toMatchObject({ host: '1.2.3.4', port: 8080 });
    now.mockRestore();
  });

  test('工厂拒绝未知 Provider 且掩码只保留 host:port', () => {
    expect(() => createProxyProvider({ provider: 'unknown' })).toThrow('不支持的代理 Provider');
    expect(maskProxyString('1.2.3.4:8080:test_user:test_password')).toBe('1.2.3.4:8080');
  });
});
