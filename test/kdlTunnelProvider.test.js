jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../src/utils/logger');
const KdlTunnelProvider = require('../src/services/crawler/proxy/kdlTunnelProvider');

describe('快代理隧道代理 Provider', () => {
  test('缺少鉴权配置时拒绝初始化', async () => {
    const provider = new KdlTunnelProvider({ host: 'primary.example', port: 15818 });

    await expect(provider.initialize()).rejects.toThrow('快代理隧道配置缺失');
  });

  test('主备入口轮换且每个请求禁用 keep-alive', async () => {
    const sessionIdFactory = jest.fn().mockReturnValueOnce('abc123').mockReturnValueOnce('def456');
    const provider = new KdlTunnelProvider({
      host: 'primary.example',
      backupHost: 'backup.example',
      port: 15818,
      username: 'test-user',
      password: 'test-password',
      sessionIdFactory,
    });

    await provider.initialize();
    expect(provider.getNextProxy()).toMatchObject({
      host: 'primary.example',
      auth: {
        username: 'test-user-period-0.5-sid-abc123-type-std-pool-q10',
        password: 'test-password',
      },
      disableKeepAlive: true,
      provider: 'kdl_tunnel',
    });
    expect(provider.getNextProxy()).toMatchObject({
      host: 'backup.example',
      auth: {
        username: 'test-user-period-0.5-sid-def456-type-std-pool-q10',
      },
    });
  });

  test('每次尝试生成新 sid 并支持覆盖资源池参数', async () => {
    const sessionIdFactory = jest.fn().mockReturnValueOnce('first!').mockReturnValueOnce('second');
    const provider = new KdlTunnelProvider({
      host: 'primary.example',
      port: 15818,
      username: 'test-user',
      password: 'test-password',
      stickyPeriod: '0.5',
      poolType: 'enh',
      poolPriority: 's10',
      sessionIdFactory,
    });

    await provider.initialize();

    expect(provider.getNextProxy().auth.username).toBe(
      'test-user-period-0.5-sid-first-type-enh-pool-s10'
    );
    expect(provider.getNextProxy().auth.username).toBe(
      'test-user-period-0.5-sid-second-type-enh-pool-s10'
    );
  });

  test('拒绝无效的固定周期或资源池配置', async () => {
    const commonOptions = {
      host: 'primary.example',
      port: 15818,
      username: 'test-user',
      password: 'test-password',
    };

    await expect(
      new KdlTunnelProvider({ ...commonOptions, stickyPeriod: '0.1' }).initialize()
    ).rejects.toThrow('固定周期配置无效');
    await expect(
      new KdlTunnelProvider({ ...commonOptions, poolType: 'unknown' }).initialize()
    ).rejects.toThrow('资源池类型配置无效');
    await expect(
      new KdlTunnelProvider({ ...commonOptions, poolPriority: 'q11' }).initialize()
    ).rejects.toThrow('资源池优先级配置无效');
  });

  test('初始化日志不包含隧道用户名和密码', async () => {
    const provider = new KdlTunnelProvider({
      host: 'primary.example',
      port: 15818,
      username: 'private-user',
      password: 'private-password',
    });

    await provider.initialize();

    const payload = JSON.stringify(logger.info.mock.calls);
    expect(payload).not.toContain('private-user');
    expect(payload).not.toContain('private-password');
    expect(payload).toContain('authConfigured');
  });
});
