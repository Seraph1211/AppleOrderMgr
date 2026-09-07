const mockGetJob = jest.fn();
const mockGetBatch = jest.fn();
const mockScheduleFindByPk = jest.fn();

jest.mock('../src/models', () => ({
  OrderRefreshSchedule: { findByPk: mockScheduleFindByPk },
}));
jest.mock('../src/services/crawler/refreshJobService', () => ({
  getJob: mockGetJob,
  getBatch: mockGetBatch,
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const controller = require('../src/controllers/orderRefreshController');

function createResponse() {
  return { json: jest.fn(value => value) };
}

describe('刷新任务与批次查询 API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('任务所有者可以读取真实任务和新鲜度状态', async () => {
    mockGetJob.mockResolvedValue({
      id: 8,
      orderId: 12,
      requestedBy: 7,
      trigger: 'manual_single',
      status: 'running',
      priority: 400,
      scheduledAt: new Date(),
      attemptCount: 1,
    });
    mockScheduleFindByPk.mockResolvedValue({
      freshnessStatus: 'refreshing',
      lastAttemptAt: new Date(),
      lastSuccessAt: null,
      lastFailureAt: null,
    });
    const res = createResponse();

    await controller.getJob({ params: { id: '8' }, user: { id: 7, role: 'operator' } }, res);

    expect(res.json.mock.calls[0][0]).toMatchObject({
      success: true,
      data: { id: 8, orderId: 12, status: 'running', refresh: { freshnessStatus: 'refreshing' } },
    });
  });

  test('普通用户不能读取其他用户提交的任务', async () => {
    mockGetJob.mockResolvedValue({ id: 8, orderId: 12, requestedBy: 9 });

    await expect(
      controller.getJob(
        { params: { id: '8' }, user: { id: 7, role: 'operator' } },
        createResponse()
      )
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  test('批次返回部分成功与失败的独立计数', async () => {
    mockGetBatch.mockResolvedValue({
      id: 3,
      requestedBy: 7,
      status: 'completed',
      totalCount: 3,
      pendingCount: 0,
      runningCount: 0,
      succeededCount: 2,
      failedCount: 1,
      skippedCount: 0,
    });
    const res = createResponse();

    await controller.getBatch({ params: { id: '3' }, user: { id: 7, role: 'operator' } }, res);

    expect(res.json.mock.calls[0][0]).toMatchObject({
      success: true,
      data: { total: 3, succeeded: 2, failed: 1, status: 'completed' },
    });
  });
});
