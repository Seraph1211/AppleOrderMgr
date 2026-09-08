jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../src/utils/logger');
const FanProxyTunnelProvider = require('../src/services/crawler/proxy/fanproxyTunnelProvider');

describe('网帆隧道代理 Provider', () => {
  beforeEach(() => jest.clearAllMocks());

  test('缺少网关或账密配置时拒绝初始化', async () => {
    const provider = new FanProxyTunnelProvider({ host: 'proxy.example', port: 9000 });

    await expect(provider.initialize()).rejects.toThrow('网帆隧道配置缺失');
  });

  test('主备入口与有界粘性会话槽轮换', async () => {
    const sessionIdFactory = jest
      .fn()
      .mockReturnValueOnce('first-01')
      .mockReturnValueOnce('next02');
    const provider = new FanProxyTunnelProvider({
      host: 'primary.example',
      backupHost: 'backup.example',
      port: 9000,
      account: 'test_account',
      password: 'test-password',
      country: 'cn',
      region: '32',
      sessionPoolSize: 2,
      sessionMode: 'sticky_pool',
      sessionIdFactory,
    });

    await provider.initialize();
    expect(provider.getNextProxy()).toMatchObject({
      host: 'primary.example',
      auth: {
        username: 'acc-test_account-cty-CN-reg-32-sid-first01',
        password: 'test-password',
      },
      provider: 'fanproxy_tunnel',
      disableKeepAlive: true,
    });
    expect(provider.getNextProxy()).toMatchObject({
      host: 'backup.example',
      auth: { username: 'acc-test_account-cty-CN-reg-32-sid-next02' },
    });
    expect(provider.getNextProxy()).toMatchObject({
      host: 'primary.example',
      auth: { username: 'acc-test_account-cty-CN-reg-32-sid-first01' },
    });
    expect(sessionIdFactory).toHaveBeenCalledTimes(2);
  });

  test('可使用官方基础账号模式且不附加 sid', async () => {
    const provider = new FanProxyTunnelProvider({
      host: 'primary.example',
      port: 9000,
      account: 'trial.user@example.com',
      password: 'test-password',
      sessionMode: 'basic',
      sessionIdFactory: () => 'session01',
    });

    await provider.initialize();

    expect(provider.getNextProxy().auth.username).toBe('acc-trial.user@example.com-cty-CN');
  });

  test('拒绝会破坏账密参数结构的配置', async () => {
    const commonOptions = {
      host: 'primary.example',
      port: 9000,
      account: 'testaccount',
      password: 'test-password',
    };

    await expect(
      new FanProxyTunnelProvider({ ...commonOptions, account: 'bad-account' }).initialize()
    ).rejects.toThrow('账号格式无效');
    await expect(
      new FanProxyTunnelProvider({ ...commonOptions, account: 'bad:account' }).initialize()
    ).rejects.toThrow('账号格式无效');
    await expect(
      new FanProxyTunnelProvider({ ...commonOptions, country: 'China' }).initialize()
    ).rejects.toThrow('国家代码无效');
    await expect(
      new FanProxyTunnelProvider({ ...commonOptions, region: '32-west' }).initialize()
    ).rejects.toThrow('地区代码无效');
    await expect(
      new FanProxyTunnelProvider({
        ...commonOptions,
        sessionMode: 'sticky_pool',
        sessionPoolSize: 0,
      }).initialize()
    ).rejects.toThrow('会话槽数量无效');
    await expect(
      new FanProxyTunnelProvider({ ...commonOptions, sessionMode: 'unknown' }).initialize()
    ).rejects.toThrow('会话模式无效');
  });

  test('初始化日志和状态不包含账号、密码或组合用户名', async () => {
    const provider = new FanProxyTunnelProvider({
      host: 'primary.example',
      port: 9000,
      account: 'privateaccount',
      password: 'private-password',
      sessionIdFactory: () => 'private-session',
    });

    await provider.initialize();
    provider.getNextProxy();

    const payload = JSON.stringify(logger.info.mock.calls);
    const status = JSON.stringify(provider.getStatus());
    expect(payload).not.toContain('privateaccount');
    expect(payload).not.toContain('private-password');
    expect(status).not.toContain('privateaccount');
    expect(status).not.toContain('private-password');
    expect(payload).toContain('authConfigured');
  });
});
