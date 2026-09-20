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

  test('20 并发套餐前 20 次使用不同槽，持续取用不会扩展会话池', async () => {
    let sessionSequence = 0;
    const sessionIdFactory = jest.fn(() => `slot${++sessionSequence}`);
    const provider = new FanProxyTunnelProvider({
      host: 'primary.example',
      port: 9000,
      account: 'testaccount',
      password: 'test-password',
      sessionPoolSize: 20,
      sessionIdFactory,
    });

    await provider.initialize();
    const firstRound = Array.from({ length: 20 }, () => provider.getNextProxy().auth.username);
    expect(new Set(firstRound).size).toBe(20);
    for (let index = 0; index < 100; index += 1) {
      expect(provider.getNextProxy().auth.username).toBe(firstRound[index % 20]);
    }
    expect(sessionIdFactory).toHaveBeenCalledTimes(20);
    expect(provider.getStatus()).toMatchObject({ sessionPoolSize: 20, sessionMode: 'sticky_pool' });
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

describe('网帆有界槽位租用及健康恢复', () => {
  let clockMs;
  let provider;
  beforeEach(async () => {
    clockMs = 1000;
    let sequence = 0;
    provider = new FanProxyTunnelProvider({
      host: 'proxy.example',
      port: 9000,
      account: 'testaccount',
      password: 'secret',
      sessionPoolSize: 2,
      now: () => clockMs,
      sessionIdFactory: () => `sid${++sequence}`,
    });
    await provider.initialize();
  });
  afterEach(() => jest.useRealTimers());

  test('并发租用互斥、取消等待不会占槽、旧释放不能解除新租用', async () => {
    const first = await provider.acquireProxy();
    const second = await provider.acquireProxy();
    expect(first.sessionSlot).not.toBe(second.sessionSlot);
    expect(provider.getStatus()).toMatchObject({ total: 2, leased: 2, available: 0 });
    const controller = new AbortController();
    const waiting = provider.acquireProxy({ signal: controller.signal });
    controller.abort(new Error('已取消'));
    await expect(waiting).rejects.toThrow('已取消');
    provider.releaseProxy(first);
    const third = await provider.acquireProxy();
    provider.releaseProxy(first);
    provider.markProxyAsBad(first);
    expect(provider.getStatus().leased).toBe(2);
    expect(provider.getStatus().bad).toBe(0);
    provider.releaseProxy(third);
    provider.releaseProxy(second);
    expect(provider.getStatus().available).toBe(2);
  });

  test('加载页单独计数不拉黑，成功重置连续失败，两次传输失败才冷却', async () => {
    const proxy = await provider.acquireProxy();
    provider.recordProxyFailure(proxy, { errorCode: 'PAGE_LOADING' });
    provider.recordProxyFailure(proxy, { errorCode: 'PARSE' });
    expect(provider.getStatus()).toMatchObject({ bad: 0, loadingCount: 1 });
    expect(provider.recordProxyFailure(proxy, { errorCode: 'REQUEST_TIMEOUT' })).toBe(false);
    provider.recordProxySuccess(proxy);
    expect(provider.recordProxyFailure(proxy, { errorCode: 'RESPONSE_STREAM' })).toBe(false);
    expect(provider.recordProxyFailure(proxy, { errorCode: 'HTTP_631' })).toBe(true);
    provider.releaseProxy(proxy);
    expect(provider.getStatus()).toMatchObject({ bad: 1, available: 1 });
    await provider.refresh();
    expect(provider.getStatus().bad).toBe(1);
    clockMs += 60001;
    const other = await provider.acquireProxy();
    const recovered = await provider.acquireProxy();
    expect(recovered.sessionSlot).toBe(proxy.sessionSlot);
    expect(recovered.auth.username).not.toBe(proxy.auth.username);
    provider.markProxyAsBad(proxy);
    expect(provider.getStatus()).toMatchObject({ total: 2, bad: 0 });
    provider.releaseProxy(recovered);
    provider.releaseProxy(other);
  });

  test('541 隔离当前槽位，池全冷却时等待到恢复再租用', async () => {
    jest.useFakeTimers();
    const first = await provider.acquireProxy();
    const second = await provider.acquireProxy();
    for (const proxy of [first, second]) {
      provider.markProxyAsBad(proxy);
      provider.releaseProxy(proxy);
    }
    expect(provider.getNextProxy()).toBeNull();
    const waiting = provider.acquireProxy();
    clockMs += 60001;
    await jest.advanceTimersByTimeAsync(100);
    const recovered = await waiting;
    expect(recovered).not.toBeNull();
    expect(provider.getStatus().total).toBe(2);
    provider.releaseProxy(recovered);
  });
});
