jest.mock('../src/models', () => ({
  Order: { findByPk: jest.fn() },
  OrderRefreshJob: {},
  OrderRefreshBatch: {},
  OrderRefreshSystemState: {},
}));
jest.mock('../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../src/utils/proxyManager', () => ({}));
jest.mock('../src/services/crawlerService', () => ({ crawlAndUpdateOrder: jest.fn() }));
jest.mock('../src/services/crawler/refreshJobRepository', () => ({
  enqueueJob: jest.fn(),
  upsertSchedule: jest.fn(),
  listDueSchedules: jest.fn(),
  finishJob: jest.fn(),
}));
const service = require('../src/services/crawler/refreshJobService');
const worker = require('../src/services/crawler/refreshWorkerService');
const repository = require('../src/services/crawler/refreshJobRepository');
const crawler = require('../src/services/crawlerService');
const { Order } = require('../src/models');
beforeEach(() => {
  jest.clearAllMocks();
  Order.findByPk.mockResolvedValue({ status: 'payment_due', paymentStatus: 'unpaid' });
});
test('入库首次任务独立标记且不设置下一次调度', async () => {
  await service.enqueueInitialRefresh({ id: 1, orderUrl: 'synthetic' });
  expect(repository.upsertSchedule).toHaveBeenCalledWith(1, {
    nextAutoRefreshAt: null,
    freshnessStatus: 'stale',
  });
  expect(repository.enqueueJob).toHaveBeenCalledWith(
    1,
    expect.objectContaining({ trigger: 'initial' })
  );
});
test('历史到期调度清空，不产生官网任务', async () => {
  const update = jest.fn();
  repository.listDueSchedules.mockResolvedValue([{ orderId: 1, update }]);
  expect(await service.enqueueDueAutoJobs()).toEqual({ scanned: 1, eligible: 0 });
  expect(update).toHaveBeenCalledWith({ nextAutoRefreshAt: null });
  expect(repository.enqueueJob).not.toHaveBeenCalled();
});
test.each(['auto', 'page_open'])('旧 %s 任务入队拒绝，执行跳过且不访问官网', async trigger => {
  expect(await service.enqueueOrderRefresh(1, { trigger })).toMatchObject({
    created: false,
    job: null,
  });
  await worker.processJob({ id: 1, orderId: 1, trigger });
  expect(crawler.crawlAndUpdateOrder).not.toHaveBeenCalled();
  expect(repository.finishJob).toHaveBeenCalledWith(expect.anything(), {
    success: true,
    skipped: true,
    nextAutoRefreshAt: null,
  });
});
test.each(['initial', 'manual_single', 'manual_all'])('%s 成功后不再自动刷新', async trigger => {
  crawler.crawlAndUpdateOrder.mockResolvedValue({ success: true });
  await worker.processJob({ id: 1, orderId: 1, trigger });
  expect(crawler.crawlAndUpdateOrder).toHaveBeenCalledWith(1, {
    source: trigger === 'initial' ? 'initial' : 'manual',
    manual: trigger !== 'initial',
  });
  expect(repository.finishJob).toHaveBeenCalledWith(expect.anything(), {
    success: true,
    skipped: false,
    nextAutoRefreshAt: null,
  });
});
test('首次失败后由人工重试，不生成周期任务', async () => {
  crawler.crawlAndUpdateOrder.mockRejectedValue(new Error('synthetic failure'));
  await worker.processJob({ id: 1, orderId: 1, trigger: 'initial' });
  expect(repository.finishJob).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      success: false,
      nextAutoRefreshAt: null,
    })
  );
});
