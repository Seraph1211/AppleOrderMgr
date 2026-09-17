jest.mock('../src/models', () => ({}));
jest.mock('../src/utils/logger', () => ({ error: jest.fn() }));
jest.mock('../src/services/crawler/refreshJobRepository', () => ({ enqueueJob: jest.fn() }));
const repository = require('../src/services/crawler/refreshJobRepository');
const { enqueueMany } = require('../src/services/crawler/refreshJobService');

test('批量部分失败保留新建、合并和不存在结果，重复项只提交一次', async () => {
  repository.enqueueJob
    .mockResolvedValueOnce({ job: { id: 10 }, created: true })
    .mockRejectedValueOnce(new Error('synthetic internal detail'))
    .mockResolvedValueOnce({ job: { id: 11 }, created: false, reason: 'merged' })
    .mockResolvedValueOnce({ job: null, created: false, reason: 'order_not_found' });
  const result = await enqueueMany([1, 2, 1, 3, 4], { requestedBy: 8 });
  expect(result).toMatchObject({ total: 4, created: 1, merged: 1, missing: 2 });
  expect(result.results.map(item => item.orderId)).toEqual([1, 2, 3, 4]);
  expect(result.results[1]).toEqual({
    orderId: 2,
    jobId: null,
    created: false,
    reason: 'submission_failed',
  });
  expect(JSON.stringify(result)).not.toContain('internal detail');
  expect(repository.enqueueJob).toHaveBeenCalledTimes(4);
});
