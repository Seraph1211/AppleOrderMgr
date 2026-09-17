jest.mock('../src/models', () => ({
  PaymentTask: { findAndCountAll: jest.fn(), findAll: jest.fn() },
  Order: {},
  User: {},
}));
jest.mock('../src/utils/logger', () => ({ error: jest.fn() }));
jest.mock('../src/services/crawler/refreshJobService', () => ({}));

const { PaymentTask } = require('../src/models');
const { listOwnTasks } = require('../src/services/paymentTaskService');

beforeEach(() => {
  jest.clearAllMocks();
  PaymentTask.findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
  PaymentTask.findAll.mockResolvedValue([]);
});

test.each([{}, { processingStatus: '' }])(
  '全部状态不排除已完成和异常且保留本人范围：%j',
  async query => {
    PaymentTask.findAndCountAll.mockResolvedValue({
      count: 2,
      rows: ['completed', 'exception'].map(processingStatus => ({
        toJSON: () => ({ processingStatus }),
      })),
    });
    const result = await listOwnTasks(17, query);
    expect(result.items.map(item => item.processingStatus)).toEqual(['completed', 'exception']);
    expect(result.pagination.total).toBe(2);
    expect(PaymentTask.findAndCountAll.mock.calls[0][0].where).toEqual({ assigneeUserId: 17 });
    for (const [options] of PaymentTask.findAll.mock.calls) {
      expect(options.where).toEqual({ assigneeUserId: 17 });
    }
  }
);

test.each(['pending', 'processing', 'completed', 'exception'])(
  '处理状态 %s 精确筛选仍限制本人',
  async processingStatus => {
    await listOwnTasks(17, { processingStatus, page: 2, limit: 10 });
    expect(PaymentTask.findAndCountAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assigneeUserId: 17, processingStatus },
        limit: 10,
        offset: 10,
      })
    );
  }
);

test('非法状态不能变成全部查询', async () => {
  await expect(listOwnTasks(17, { processingStatus: 'all' })).rejects.toThrow(
    'processingStatus 非法'
  );
  expect(PaymentTask.findAndCountAll).not.toHaveBeenCalled();
});

test('查询失败继续向调用方报告', async () => {
  PaymentTask.findAndCountAll.mockRejectedValue(new Error('synthetic query failure'));
  await expect(listOwnTasks(17)).rejects.toThrow('synthetic query failure');
});
