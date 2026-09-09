jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/models', () => ({ OrderRefreshSystemState: { findByPk: jest.fn() } }));
jest.mock('../src/utils/config', () => ({
  config: {
    crawler: { workerConcurrency: 20, jobLeaseMs: 300000, scheduleScanLimit: 500 },
    proxy: {
      enabled: true,
      provider: 'fanproxy_tunnel',
      fanproxyTunnel: { host: 'test', port: 1, account: 'test', password: 'test' },
    },
  },
}));
jest.mock('../src/utils/proxyManager', () => ({ getStatus: jest.fn(), switchProvider: jest.fn() }));
jest.mock('../src/services/crawlerService', () => ({ crawlAndUpdateOrder: jest.fn() }));
jest.mock('../src/services/crawler/proxy/proxyHealthCheck', () => ({
  validateProxyProviderCandidate: jest.fn(),
}));
jest.mock('../src/services/crawler/refreshJobRepository', () => ({
  heartbeat: jest.fn(),
  ensureSystemState: jest.fn(),
  renewActiveLeases: jest.fn(),
  recoverExpiredLeases: jest.fn(),
  claimDueJobs: jest.fn(),
  finishJob: jest.fn(),
  pause: jest.fn(),
  startProxyProviderSwitch: jest.fn(),
  completeProxyProviderSwitch: jest.fn(),
  failProxyProviderSwitch: jest.fn(),
}));
jest.mock('../src/services/crawler/refreshJobService', () => ({
  enqueueDueAutoJobs: jest.fn(),
  calculateNextRefresh: jest.fn(),
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('Worker 按空闲名额持续领取', () => {
  let worker;
  let repository;
  let crawler;
  let proxy;
  let state;
  let pending;
  beforeEach(() => {
    jest.resetModules();
    worker = require('../src/services/crawler/refreshWorkerService');
    repository = require('../src/services/crawler/refreshJobRepository');
    crawler = require('../src/services/crawlerService');
    proxy = require('../src/utils/proxyManager');
    state = {
      activeProxyProvider: 'fanproxy_tunnel',
      requestedProxyProvider: 'fanproxy_tunnel',
      proxySwitchStatus: 'succeeded',
      isPaused: false,
    };
    repository.heartbeat.mockImplementation(() => Promise.resolve({ ...state }));
    repository.ensureSystemState.mockImplementation(() => Promise.resolve({ ...state }));
    repository.claimDueJobs.mockResolvedValue([]);
    proxy.getStatus.mockReturnValue({ activeProvider: 'fanproxy_tunnel', isInitialized: true });
    pending = [];
    crawler.crawlAndUpdateOrder.mockImplementation(() => {
      const request = deferred();
      pending.push(request);
      return request.promise;
    });
  });
  afterEach(async () => {
    pending.forEach(request => request.resolve({ success: true }));
    await worker.stop();
  });
  const job = id => ({ id, orderId: id, trigger: 'manual_single' });

  test('旧任务未完成，晚入队任务可在下一轮使用空闲名额', async () => {
    repository.claimDueJobs.mockResolvedValueOnce([job(1)]).mockResolvedValueOnce([job(2)]);
    expect((await worker.runOnce()).claimed).toBe(1);
    expect((await worker.runOnce()).claimed).toBe(1);
    expect(crawler.crawlAndUpdateOrder).toHaveBeenCalledTimes(2);
    expect(repository.finishJob).not.toHaveBeenCalled();
    expect(repository.claimDueJobs.mock.calls.map(call => call[1])).toEqual([20, 19]);
    expect(worker.getStatus()).toMatchObject({ inFlight: 2, isProcessing: true });
    expect(repository.renewActiveLeases).toHaveBeenLastCalledWith(expect.any(String), [1], 300000);
  });

  test('20 个在途任务占满时不超领，释放一个后只补一个', async () => {
    repository.claimDueJobs.mockResolvedValueOnce(Array.from({ length: 20 }, (_, i) => job(i + 1)));
    await worker.runOnce();
    expect((await worker.runOnce()).reason).toBe('concurrency_full');
    expect(repository.claimDueJobs).toHaveBeenCalledTimes(1);
    pending[0].resolve({ success: true });
    await new Promise(resolve => setImmediate(resolve));
    repository.claimDueJobs.mockResolvedValueOnce([job(21)]);
    await worker.runOnce();
    expect(repository.claimDueJobs).toHaveBeenLastCalledWith(expect.any(String), 1, 300000);
    expect(worker.getStatus().inFlight).toBe(20);
  });

  test('领取循环重叠时不重复计算名额或重复领取', async () => {
    const claim = deferred();
    repository.claimDueJobs.mockReturnValueOnce(claim.promise);
    const tick = worker.runOnce();
    await new Promise(resolve => setImmediate(resolve));
    expect((await worker.runOnce()).reason).toBe('previous_tick_running');
    claim.resolve([job(1)]);
    await tick;
    expect(repository.claimDueJobs).toHaveBeenCalledTimes(1);
  });

  test('结果写入失败不泄漏名额或产生未处理的 Promise 拒绝', async () => {
    repository.claimDueJobs.mockResolvedValueOnce([job(1)]);
    repository.finishJob.mockRejectedValueOnce(new Error('private database error'));
    await worker.runOnce();
    pending[0].resolve({ success: true });
    await worker.waitForIdle();
    expect(worker.getStatus().inFlight).toBe(0);
    expect(require('../src/utils/logger').error).toHaveBeenCalledWith(
      '刷新任务结果持久化失败，任务将等待租约恢复',
      { jobId: 1 }
    );
    await worker.runOnce();
    expect(repository.claimDueJobs).toHaveBeenLastCalledWith(expect.any(String), 20, 300000);
  });

  test('暂停后续租在途任务但不补位', async () => {
    repository.claimDueJobs.mockResolvedValueOnce([job(1)]);
    await worker.runOnce();
    state.isPaused = true;
    expect((await worker.runOnce()).skipped).toBe(true);
    expect(repository.claimDueJobs).toHaveBeenCalledTimes(1);
    expect(repository.renewActiveLeases).toHaveBeenLastCalledWith(expect.any(String), [1], 300000);
  });

  test('切换请求停止补位并在全部在途任务结束后才切换', async () => {
    repository.claimDueJobs.mockResolvedValueOnce([job(1)]);
    await worker.runOnce();
    state.proxySwitchStatus = 'pending';
    expect((await worker.runOnce()).reason).toBe('proxy_switch_draining');
    expect(repository.completeProxyProviderSwitch).not.toHaveBeenCalled();
    pending[0].resolve({ success: true });
    await worker.waitForIdle();
    repository.completeProxyProviderSwitch.mockImplementation(() => {
      state.proxySwitchStatus = 'succeeded';
      return Promise.resolve();
    });
    await worker.runOnce();
    expect(repository.completeProxyProviderSwitch).toHaveBeenCalledWith('fanproxy_tunnel');
    expect(repository.claimDueJobs).toHaveBeenCalledTimes(2);
  });

  test('候选失败后仍用原代理持续补位', async () => {
    state.requestedProxyProvider = 'yiyou_http';
    state.proxySwitchStatus = 'failed';
    repository.claimDueJobs.mockResolvedValueOnce([job(1)]).mockResolvedValueOnce([job(2)]);
    await worker.runOnce();
    await worker.runOnce();
    expect(worker.getStatus().inFlight).toBe(2);
    expect(proxy.switchProvider).not.toHaveBeenCalled();
  });

  test('扫描期间收到暂停请求，领取前再次检查', async () => {
    const service = require('../src/services/crawler/refreshJobService');
    service.enqueueDueAutoJobs.mockImplementationOnce(() => {
      state.isPaused = true;
      return Promise.resolve();
    });
    expect((await worker.runOnce()).reason).toBe('paused');
    expect(repository.claimDueJobs).not.toHaveBeenCalled();
  });

  test('关闭期间等待正在领取的任务和结果写入，不再接受下一轮', async () => {
    const claim = deferred();
    const persisted = deferred();
    repository.claimDueJobs.mockReturnValueOnce(claim.promise);
    repository.finishJob.mockReturnValueOnce(persisted.promise);
    const tick = worker.runOnce();
    await new Promise(resolve => setImmediate(resolve));
    let stopped = false;
    const stop = worker.stop().then(() => {
      stopped = true;
    });
    claim.resolve([job(1)]);
    await tick;
    expect(stopped).toBe(false);
    pending[0].resolve({ success: true });
    await new Promise(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect((await worker.runOnce()).reason).toBe('worker_stopping');
    persisted.resolve();
    await stop;
    expect(stopped).toBe(true);
    expect(worker.getStatus().inFlight).toBe(0);
  });
});
