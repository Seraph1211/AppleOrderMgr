jest.mock('../src/utils/config', () => ({ config: { crawler: { requestsPerSecond: 5 } } }));
jest.mock('../src/utils/logger', () => ({ error: jest.fn() }));
jest.mock('../src/services/crawler/refreshJobRepository', () => ({
  reserveRequestSlot: jest.fn(),
}));
const repository = require('../src/services/crawler/refreshJobRepository');
const limiter = require('../src/services/crawler/crawlerRateLimiter');

test('限流时隙等待响应取消，已取消任务不再预留新时隙', async () => {
  repository.reserveRequestSlot.mockResolvedValue(10000);
  const controller = new AbortController();
  const waiting = limiter.acquire({ signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error('budget expired'));
  await expect(waiting).rejects.toThrow('budget expired');
  await expect(limiter.acquire({ signal: controller.signal })).rejects.toThrow('budget expired');
  expect(repository.reserveRequestSlot).toHaveBeenCalledTimes(1);
});
