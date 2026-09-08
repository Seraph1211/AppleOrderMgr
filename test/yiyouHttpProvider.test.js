const axios = require('axios');

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
};

jest.mock('axios');
jest.mock('../src/utils/logger', () => mockLogger);

const YiyouHttpProvider = require('../src/services/crawler/proxy/yiyouHttpProvider');

describe('亦优 HTTP 代理 Provider', () => {
  beforeEach(() => jest.clearAllMocks());

  test('解析带独立鉴权的换行文本且不复用连接', () => {
    const provider = new YiyouHttpProvider({ apiUrl: 'https://api.yiyouip.com/test' });

    expect(provider.parseProxyResponse('1.2.3.4:8080 test-user test-pass\n')).toEqual([
      {
        host: '1.2.3.4',
        port: 8080,
        auth: { username: 'test-user', password: 'test-pass' },
        provider: 'yiyou_http',
        disableKeepAlive: true,
      },
    ]);
  });

  test('无效记录只记数不记凭据', () => {
    const provider = new YiyouHttpProvider({ apiUrl: 'https://api.yiyouip.com/test' });
    const raw = '1.2.3.999:8080 leaked-user leaked-pass\ninvalid leaked-user leaked-pass';

    expect(provider.parseProxyResponse(raw)).toEqual([]);
    const logPayload = JSON.stringify(mockLogger.warn.mock.calls);
    expect(logPayload).not.toContain('leaked-user');
    expect(logPayload).not.toContain('leaked-pass');
    expect(logPayload).toContain('invalidCount');
  });

  test('拒绝非官方域名或非 HTTPS 提取地址', () => {
    const insecure = new YiyouHttpProvider({ apiUrl: 'http://api.yiyouip.com/test' });
    const otherHost = new YiyouHttpProvider({ apiUrl: 'https://example.com/test' });

    expect(() => insecure.validateApiUrl()).toThrow('官方 HTTPS 域名');
    expect(() => otherHost.validateApiUrl()).toThrow('官方 HTTPS 域名');
  });

  test('刷新后加载代理，达到安全 TTL 后要求重新提取', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    axios.get.mockResolvedValue({ data: '1.2.3.4:8080 test-user test-pass\n' });
    const provider = new YiyouHttpProvider({
      apiUrl: 'https://api.yiyouip.com/test',
      poolTtlMs: 240000,
    });

    await provider.initialize();
    expect(provider.getNextProxy()).toMatchObject({ host: '1.2.3.4', port: 8080 });

    now.mockReturnValue(241000);
    expect(provider.getNextProxy()).toBeNull();
    expect(provider.getStatus()).toMatchObject({ total: 1, available: 0, bad: 1 });
    now.mockRestore();
  });

  test('HTTP 541 废弃当前 IP 并轮询到下一条', () => {
    const provider = new YiyouHttpProvider({
      apiUrl: 'https://api.yiyouip.com/test',
      badProxyTimeout: 240000,
    });
    provider.proxies = provider.parseProxyResponse(
      '1.2.3.4:8080 user-a pass-a\n5.6.7.8:8081 user-b pass-b\n'
    );
    provider.expiresAt = Date.now() + 240000;
    const first = provider.getNextProxy();

    provider.markProxyAsBad(first);

    expect(provider.getNextProxy()).toMatchObject({ host: '5.6.7.8', port: 8081 });
  });
});
