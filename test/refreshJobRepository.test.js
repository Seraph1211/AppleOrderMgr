const mockTransaction = jest.fn();
const mockOrderFindByPk = jest.fn();
const mockScheduleFindOrCreate = jest.fn();
const mockJobFindOne = jest.fn();
const mockJobCreate = jest.fn();
const mockJobFindAll = jest.fn();
const mockJobUpdate = jest.fn();
const mockBatchFindByPk = jest.fn();
const mockSystemFindOrCreate = jest.fn();

jest.mock('../src/models', () => ({
  sequelize: {
    transaction: mockTransaction,
    fn: jest.fn(),
    col: jest.fn(),
  },
  Order: { findByPk: mockOrderFindByPk },
  OrderRefreshSchedule: { findOrCreate: mockScheduleFindOrCreate, findAll: jest.fn() },
  OrderRefreshJob: {
    findOne: mockJobFindOne,
    create: mockJobCreate,
    findAll: mockJobFindAll,
    update: mockJobUpdate,
    findByPk: jest.fn(),
  },
  OrderRefreshBatch: {
    findOne: jest.fn(),
    create: jest.fn(),
    findByPk: mockBatchFindByPk,
  },
  OrderRefreshSystemState: { findOrCreate: mockSystemFindOrCreate },
}));

const repository = require('../src/services/crawler/refreshJobRepository');

const transaction = { LOCK: { UPDATE: 'UPDATE' } };

describe('订单刷新任务仓储', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.mockImplementation(callback => callback(transaction));
  });

  test('重复待执行任务合并并提升人工单笔优先级', async () => {
    const schedule = { isNewRecord: false, update: jest.fn() };
    const activeJob = {
      id: 9,
      status: 'pending',
      priority: 100,
      scheduledAt: new Date('2026-09-07T00:01:00Z'),
      requestedBy: null,
      batchId: null,
      update: jest.fn(function update(values) {
        Object.assign(this, values);
      }),
    };
    mockOrderFindByPk.mockResolvedValue({ id: 1 });
    mockScheduleFindOrCreate.mockResolvedValue([schedule]);
    mockJobFindOne.mockResolvedValue(activeJob);

    const result = await repository.enqueueJob(1, {
      trigger: 'manual_single',
      priority: 400,
      scheduledAt: new Date('2026-09-07T00:00:00Z'),
      requestedBy: 7,
      batchId: 3,
    });

    expect(result).toMatchObject({ job: activeJob, created: false, reason: 'merged' });
    expect(activeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 400,
        trigger: 'manual_single',
        requestedBy: 7,
        batchId: 3,
      }),
      { transaction }
    );
    expect(mockJobCreate).not.toHaveBeenCalled();
  });

  test('订单不存在时不创建孤儿任务', async () => {
    mockOrderFindByPk.mockResolvedValue(null);

    await expect(repository.enqueueJob(404, {})).resolves.toEqual({
      job: null,
      created: false,
      reason: 'order_not_found',
    });
    expect(mockJobCreate).not.toHaveBeenCalled();
  });

  test('领取任务写入 Worker 租约并把调度标记为 refreshing', async () => {
    const job = {
      id: 11,
      orderId: 1,
      attemptCount: 2,
      update: jest.fn(function update(values) {
        Object.assign(this, values);
      }),
    };
    const schedule = {
      isNewRecord: false,
      update: jest.fn(),
    };
    mockJobFindAll.mockResolvedValue([job]);
    mockScheduleFindOrCreate.mockResolvedValue([schedule]);

    const result = await repository.claimDueJobs('worker-a', 1, 60_000);

    expect(result).toEqual([job]);
    expect(job.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'running',
        leaseOwner: 'worker-a',
        attemptCount: 3,
      }),
      { transaction }
    );
    expect(schedule.update).toHaveBeenCalledWith(
      expect.objectContaining({ freshnessStatus: 'refreshing' }),
      { transaction }
    );
  });

  test('只恢复租约已过期的运行中任务', async () => {
    mockJobUpdate.mockResolvedValue([2]);

    await expect(repository.recoverExpiredLeases(new Date(0))).resolves.toBe(2);

    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', leaseOwner: null, leaseExpiresAt: null }),
      expect.objectContaining({ where: expect.objectContaining({ status: 'running' }) })
    );
  });

  test('批次统计允许部分失败且仅在无待执行任务时完成', async () => {
    const batch = {
      skippedCount: 0,
      startedAt: null,
      update: jest.fn(function update(values) {
        Object.assign(this, values);
      }),
    };
    mockBatchFindByPk.mockResolvedValue(batch);
    mockJobFindAll.mockResolvedValue([
      { status: 'succeeded', count: '2' },
      { status: 'failed', count: '1' },
    ]);

    await repository.refreshBatchCounts(5);

    expect(batch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        succeededCount: 2,
        failedCount: 1,
        pendingCount: 0,
      }),
      { transaction }
    );
  });

  test('代理切换请求在行锁中只持久化非敏感状态', async () => {
    const state = {
      activeProxyProvider: 'kdl_tunnel',
      reload: jest.fn(),
      update: jest.fn(function update(values) {
        Object.assign(this, values);
      }),
    };
    mockSystemFindOrCreate.mockResolvedValue([state]);

    const result = await repository.requestProxyProviderSwitch('kdl_private', 7);

    expect(state.reload).toHaveBeenCalledWith({ transaction, lock: 'UPDATE' });
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedProxyProvider: 'kdl_private',
        proxySwitchStatus: 'pending',
        proxySwitchErrorCode: null,
        proxySwitchErrorMessage: null,
        updatedBy: 7,
      }),
      { transaction }
    );
    expect(result).toBe(state);
  });
});
