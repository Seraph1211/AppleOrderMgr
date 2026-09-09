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
      fanproxyTunnel: {
        host: 'fanproxy.example',
        port: 9000,
        account: 'testaccount',
        password: 'test-password',
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

  test('网帆隧道沿用候选验证后原子切换流程', async () => {
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
    mockEnsureSystemState.mockResolvedValue({ requestedProxyProvider: 'fanproxy_tunnel' });

    const result = await refreshWorkerService.reconcileProxyProvider({
      requestedProxyProvider: 'fanproxy_tunnel',
      activeProxyProvider: 'kdl_tunnel',
      proxySwitchStatus: 'pending',
    });

    expect(mockStartProxyProviderSwitch).toHaveBeenCalledWith('fanproxy_tunnel');
    expect(mockValidateCandidate).toHaveBeenCalledWith(candidate);
    expect(mockCompleteProxyProviderSwitch).toHaveBeenCalledWith('fanproxy_tunnel');
    expect(result).toEqual({ switched: true, activeProvider: 'fanproxy_tunnel' });
  });

  test('切换失败后冷启动先恢复网帆，保留失败候选诊断并继续领取任务', async () => {
    const state = {
      requestedProxyProvider: 'kdl_private',
      activeProxyProvider: 'fanproxy_tunnel',
      proxySwitchStatus: 'failed',
    };
    const repository = require('../src/services/crawler/refreshJobRepository');
    const jobs = require('../src/services/crawler/refreshJobService');
    repository.heartbeat.mockResolvedValue(state);
    repository.claimDueJobs.mockResolvedValue([]);
    mockEnsureSystemState.mockResolvedValue(state);
    mockProxyStatus.mockReturnValue({ activeProvider: null, isInitialized: false });
    mockSwitchProvider.mockImplementation(async (provider, options) => {
      await options.validateCandidate({});
      mockProxyStatus.mockReturnValue({ activeProvider: provider, isInitialized: true });
      return { changed: true, activeProvider: provider };
    });
    const result = await refreshWorkerService.runOnce();
    expect(result.skipped).toBe(false);
    expect(mockSwitchProvider.mock.calls[0][0]).toBe('fanproxy_tunnel');
    expect(mockValidateCandidate).toHaveBeenCalled();
    expect(mockCompleteProxyProviderSwitch).not.toHaveBeenCalled();
    expect(mockFailProxyProviderSwitch).not.toHaveBeenCalled();
    expect(jobs.enqueueDueAutoJobs).toHaveBeenCalled();
    expect(repository.claimDueJobs).toHaveBeenCalled();
    expect(repository.heartbeat).toHaveBeenCalledWith(expect.any(String), {
      workerProxyReady: true,
      workerProxyErrorCode: null,
    });
  });

  test('原代理恢复失败公开阻塞且一分钟内不反复请求', async () => {
    const state = {
      requestedProxyProvider: 'kdl_private',
      activeProxyProvider: 'fanproxy_tunnel',
      proxySwitchStatus: 'failed',
      proxySwitchRequestedAt: 'recovery-failure',
    };
    const repository = require('../src/services/crawler/refreshJobRepository');
    repository.heartbeat.mockResolvedValue(state);
    mockProxyStatus.mockReturnValue({ activeProvider: null, isInitialized: false });
    mockSwitchProvider.mockRejectedValue(new Error('secret upstream details'));
    expect((await refreshWorkerService.runOnce()).reason).toBe('PROXY_RECOVERY_FAILED');
    expect((await refreshWorkerService.runOnce()).reason).toBe('PROXY_RECOVERY_FAILED');
    expect(mockSwitchProvider).toHaveBeenCalledTimes(1);
    expect(repository.claimDueJobs).not.toHaveBeenCalled();
    expect(repository.heartbeat).toHaveBeenCalledWith(expect.any(String), {
      workerProxyReady: false,
      workerProxyErrorCode: 'PROXY_RECOVERY_FAILED',
    });
  });

  test('没有历史有效代理时不冒充就绪', async () => {
    mockProxyStatus.mockReturnValue({ activeProvider: null, isInitialized: false });
    expect(
      await refreshWorkerService.reconcileProxyProvider({
        requestedProxyProvider: 'kdl_private',
        proxySwitchStatus: 'failed',
      })
    ).toMatchObject({ reason: 'PROXY_RECOVERY_UNAVAILABLE' });
    expect(mockSwitchProvider).not.toHaveBeenCalled();
  });

  test('恢复期间新切换请求不被旧恢复结果覆盖', async () => {
    mockProxyStatus.mockReturnValue({ activeProvider: null, isInitialized: false });
    mockEnsureSystemState.mockResolvedValue({
      requestedProxyProvider: 'kdl_tunnel',
      activeProxyProvider: 'fanproxy_tunnel',
    });
    mockSwitchProvider.mockImplementation(async (_provider, options) => {
      await options.validateCandidate({});
    });
    expect(
      await refreshWorkerService.reconcileProxyProvider({
        requestedProxyProvider: 'kdl_private',
        activeProxyProvider: 'fanproxy_tunnel',
        proxySwitchStatus: 'failed',
        proxySwitchRequestedAt: 'new-request',
      })
    ).toMatchObject({ reason: 'switch_request_superseded' });
    expect(mockCompleteProxyProviderSwitch).not.toHaveBeenCalled();
  });
});

describe('队列触发类型与爬虫日志来源兼容', () => {
  test.each([
    ['manual_single', 'manual', true],
    ['manual_all', 'manual', true],
    ['auto', 'scheduled', false],
    ['page_open', 'page_open', false],
  ])('%s 使用日志来源 %s', async (trigger, source, manual) => {
    jest.doMock('../src/services/crawlerService', () => ({
      crawlAndUpdateOrder: jest
        .fn()
        .mockResolvedValue({ success: true, skipped: trigger === 'page_open' }),
    }));
    const crawler = require('../src/services/crawlerService');
    const repository = require('../src/services/crawler/refreshJobRepository');
    const jobs = require('../src/services/crawler/refreshJobService');
    jobs.calculateNextRefresh.mockResolvedValue(null);
    const job = { id: 1, orderId: 108, trigger };
    await refreshWorkerService.processJob(job);
    expect(crawler.crawlAndUpdateOrder).toHaveBeenLastCalledWith(108, { source, manual });
    expect(repository.finishJob).toHaveBeenLastCalledWith(
      job,
      expect.objectContaining({ success: true })
    );
  });
});
