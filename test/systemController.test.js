const mockEnsureSystemState = jest.fn();
const mockResume = jest.fn();
const mockRequestProxyProviderSwitch = jest.fn();
const mockJobFindAll = jest.fn();
const mockScheduleFindAll = jest.fn();

jest.mock('../src/models', () => ({
  CrawlLog: {},
  Order: {},
  OrderRefreshJob: {
    findAll: mockJobFindAll,
    sequelize: { fn: jest.fn(), col: jest.fn() },
  },
  OrderRefreshSchedule: {
    findAll: mockScheduleFindAll,
    sequelize: { fn: jest.fn(), col: jest.fn() },
  },
}));
jest.mock('../src/services/crawler/refreshJobRepository', () => ({
  ensureSystemState: mockEnsureSystemState,
  resume: mockResume,
  requestProxyProviderSwitch: mockRequestProxyProviderSwitch,
}));
jest.mock('../src/utils/config', () => ({
  config: {
    proxy: {
      enabled: true,
      provider: 'kdl_tunnel',
      apiUrl: 'https://proxy.example/api',
      tunnel: {
        host: 'tunnel.example',
        port: 15818,
        username: 'secret-user',
        password: 'secret-password',
      },
      fanproxyTunnel: {
        host: 'fanproxy.example',
        port: 9000,
        account: 'fanproxy-account',
        password: 'fanproxy-password',
      },
      yiyouHttp: {
        apiUrl: 'https://api.yiyouip.com/private',
      },
    },
  },
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const systemController = require('../src/controllers/systemController');

describe('独立爬虫 Worker 持久化状态与控制', () => {
  const originalEnabled = process.env.AUTO_ORDER_REFRESH_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AUTO_ORDER_REFRESH_ENABLED = 'true';
    mockEnsureSystemState.mockResolvedValue({
      isPaused: false,
      pauseReason: null,
      pausedAt: null,
      workerId: 'worker:test',
      heartbeatAt: new Date(),
      requestedProxyProvider: 'kdl_tunnel',
      activeProxyProvider: 'kdl_tunnel',
      proxySwitchStatus: 'succeeded',
      proxySwitchErrorCode: null,
      proxySwitchErrorMessage: null,
    });
    mockJobFindAll.mockResolvedValue([{ status: 'pending', count: '2' }]);
    mockScheduleFindAll.mockResolvedValue([{ freshnessStatus: 'stale', count: '3' }]);
  });

  afterAll(() => {
    if (originalEnabled === undefined) delete process.env.AUTO_ORDER_REFRESH_ENABLED;
    else process.env.AUTO_ORDER_REFRESH_ENABLED = originalEnabled;
  });

  test('返回 PostgreSQL 队列、心跳和新鲜度状态', async () => {
    const res = { json: jest.fn() };

    await systemController.getAutoRefreshStatus({}, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.controlMode).toBe('external_worker');
    expect(data.controlAvailable).toBe(true);
    expect(data.isRunning).toBe(true);
    expect(data.isPaused).toBe(false);
    expect(data.statusSource).toBe('postgresql');
    expect(data.queue).toEqual({ pending: 2 });
    expect(data.freshness).toEqual({ stale: 3 });
  });

  test('恢复接口清除持久化暂停状态', async () => {
    mockResume.mockResolvedValue({
      isPaused: false,
      pausedAt: null,
      pauseReason: null,
      heartbeatAt: new Date(),
    });
    const res = { json: jest.fn() };

    await systemController.resumeAutoRefresh({ user: { id: 7 } }, res);

    expect(mockResume).toHaveBeenCalledWith(7);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      success: true,
      data: { isPaused: false },
    });
  });

  test('代理状态只返回配置完整性和 Worker 确认结果', async () => {
    const res = { json: jest.fn() };

    await systemController.getProxyProviderStatus({}, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data).toMatchObject({
      enabled: true,
      requestedProvider: 'kdl_tunnel',
      activeProvider: 'kdl_tunnel',
      switchStatus: 'succeeded',
    });
    expect(payload.data.providers['kdl_tunnel']).toEqual({ configured: true });
    expect(payload.data.providers['kdl_private']).toEqual({ configured: true });
    expect(payload.data.providers['fanproxy_tunnel']).toEqual({ configured: true });
    expect(payload.data.providers['yiyou_http']).toEqual({ configured: true });
    expect(JSON.stringify(payload)).not.toContain('secret-user');
    expect(JSON.stringify(payload)).not.toContain('secret-password');
    expect(JSON.stringify(payload)).not.toContain('proxy.example');
    expect(JSON.stringify(payload)).not.toContain('fanproxy-account');
    expect(JSON.stringify(payload)).not.toContain('fanproxy-password');
    expect(JSON.stringify(payload)).not.toContain('yiyouip.com');
  });

  test('管理员提交私密代理切换请求并收到 202', async () => {
    mockRequestProxyProviderSwitch.mockResolvedValue({
      requestedProxyProvider: 'kdl_private',
      activeProxyProvider: 'kdl_tunnel',
      proxySwitchStatus: 'pending',
      heartbeatAt: new Date(),
    });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await systemController.switchProxyProvider(
      { body: { provider: 'kdl_private' }, user: { id: 7 } },
      res
    );

    expect(mockRequestProxyProviderSwitch).toHaveBeenCalledWith('kdl_private', 7);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      success: true,
      data: { requestedProvider: 'kdl_private', activeProvider: 'kdl_tunnel' },
    });
  });

  test('拒绝未知代理 Provider', async () => {
    await expect(
      systemController.switchProxyProvider(
        { body: { provider: 'unknown' }, user: { id: 7 } },
        { status: jest.fn(), json: jest.fn() }
      )
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(mockRequestProxyProviderSwitch).not.toHaveBeenCalled();
  });

  test('管理员可以提交网帆隧道切换请求', async () => {
    mockRequestProxyProviderSwitch.mockResolvedValue({
      requestedProxyProvider: 'fanproxy_tunnel',
      activeProxyProvider: 'kdl_tunnel',
      proxySwitchStatus: 'pending',
      heartbeatAt: new Date(),
    });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await systemController.switchProxyProvider(
      { body: { provider: 'fanproxy_tunnel' }, user: { id: 7 } },
      res
    );

    expect(mockRequestProxyProviderSwitch).toHaveBeenCalledWith('fanproxy_tunnel', 7);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  test('管理员可以提交亦优 HTTP 切换请求', async () => {
    mockRequestProxyProviderSwitch.mockResolvedValue({
      requestedProxyProvider: 'yiyou_http',
      activeProxyProvider: 'kdl_private',
      proxySwitchStatus: 'pending',
      heartbeatAt: new Date(),
    });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await systemController.switchProxyProvider(
      { body: { provider: 'yiyou_http' }, user: { id: 7 } },
      res
    );

    expect(mockRequestProxyProviderSwitch).toHaveBeenCalledWith('yiyou_http', 7);
    expect(res.status).toHaveBeenCalledWith(202);
  });
});
