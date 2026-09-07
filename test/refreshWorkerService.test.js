const mockProxyStatus = jest.fn();
const mockSwitchProvider = jest.fn();
const mockEnsureSystemState = jest.fn();
const mockStartProxyProviderSwitch = jest.fn();
const mockCompleteProxyProviderSwitch = jest.fn();
const mockFailProxyProviderSwitch = jest.fn();
const mockValidateCandidate = jest.fn();

jest.mock('../src/models', () => ({
  OrderRefreshSystemState: { findByPk: jest.fn() },
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
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
        username: 'user',
        password: 'password',
      },
    },
    crawler: {
      autoRefreshEnabled: true,
      schedulerTickMs: 5000,
      workerConcurrency: 1,
      scheduleScanLimit: 10,
      jobLeaseMs: 60000,
    },
  },
}));
jest.mock('../src/utils/proxyManager', () => ({
  getStatus: mockProxyStatus,
  switchProvider: mockSwitchProvider,
}));
jest.mock('../src/services/crawler/refreshJobRepository', () => ({
  ensureSystemState: mockEnsureSystemState,
  startProxyProviderSwitch: mockStartProxyProviderSwitch,
  completeProxyProviderSwitch: mockCompleteProxyProviderSwitch,
  failProxyProviderSwitch: mockFailProxyProviderSwitch,
  heartbeat: jest.fn(),
  recoverExpiredLeases: jest.fn(),
  claimDueJobs: jest.fn(),
  finishJob: jest.fn(),
  pause: jest.fn(),
}));
jest.mock('../src/services/crawler/refreshJobService', () => ({
  enqueueDueAutoJobs: jest.fn(),
  calculateNextRefresh: jest.fn(),
}));
jest.mock('../src/services/crawler/proxy/proxyHealthCheck', () => ({
  validateProxyProviderCandidate: mockValidateCandidate,
}));

const refreshWorkerService = require('../src/services/crawler/refreshWorkerService');

describe('爬虫 Worker 代理 Provider 切换', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProxyStatus.mockReturnValue({
      activeProvider: 'kdl_tunnel',
      isInitialized: true,
    });
    mockEnsureSystemState.mockResolvedValue({ requestedProxyProvider: 'kdl_private' });
    mockStartProxyProviderSwitch.mockResolvedValue({});
    mockCompleteProxyProviderSwitch.mockResolvedValue({});
    mockFailProxyProviderSwitch.mockResolvedValue({});
    mockValidateCandidate.mockResolvedValue({ statusCode: 200 });
  });

  test('候选 Provider 验证成功后才确认切换', async () => {
    const candidate = {};
    mockSwitchProvider.mockImplementation(async (providerName, options) => {
      await options.validateCandidate(candidate);
      mockProxyStatus.mockReturnValue({ activeProvider: providerName, isInitialized: true });
      return {
        changed: true,
        previousProvider: 'kdl_tunnel',
        activeProvider: providerName,
      };
    });

    const result = await refreshWorkerService.reconcileProxyProvider({
      requestedProxyProvider: 'kdl_private',
      activeProxyProvider: 'kdl_tunnel',
      proxySwitchStatus: 'pending',
    });

    expect(mockStartProxyProviderSwitch).toHaveBeenCalledWith('kdl_private');
    expect(mockValidateCandidate).toHaveBeenCalledWith(candidate);
    expect(mockCompleteProxyProviderSwitch).toHaveBeenCalledWith('kdl_private');
    expect(result).toEqual({ switched: true, activeProvider: 'kdl_private' });
  });

  test('候选 Provider 失败时记录脱敏错误并保留旧 Provider', async () => {
    const healthError = new Error('contains-sensitive-upstream-detail');
    healthError.code = 'PROXY_407';
    mockSwitchProvider.mockRejectedValue(healthError);

    const result = await refreshWorkerService.reconcileProxyProvider({
      requestedProxyProvider: 'kdl_private',
      activeProxyProvider: 'kdl_tunnel',
      proxySwitchStatus: 'pending',
    });

    expect(mockCompleteProxyProviderSwitch).not.toHaveBeenCalled();
    expect(mockFailProxyProviderSwitch).toHaveBeenCalledWith('PROXY_407', '候选代理鉴权失败');
    expect(mockFailProxyProviderSwitch.mock.calls.flat().join(' ')).not.toContain(
      'contains-sensitive-upstream-detail'
    );
    expect(result).toEqual({ switched: false, errorCode: 'PROXY_407' });
    expect(mockProxyStatus().activeProvider).toBe('kdl_tunnel');
  });

  test('失败状态不会在没有新请求时无限重试', async () => {
    const result = await refreshWorkerService.reconcileProxyProvider({
      requestedProxyProvider: 'kdl_private',
      activeProxyProvider: 'kdl_tunnel',
      proxySwitchStatus: 'failed',
    });

    expect(result).toEqual({ skipped: true, reason: 'awaiting_new_switch_request' });
    expect(mockSwitchProvider).not.toHaveBeenCalled();
  });
});
