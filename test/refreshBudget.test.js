const { createRefreshBudget, waitForRefresh } = require('../src/services/crawler/refreshBudget');

describe('抓取总预算与取消等待', () => {
  afterEach(() => jest.useRealTimers());

  test('到期中止等待，保留总预算错误码', async () => {
    jest.useFakeTimers();
    const budget = createRefreshBudget(50);
    const result = expect(waitForRefresh(1000, budget.signal)).rejects.toMatchObject({
      refreshErrorCode: 'TASK_TIMEOUT',
    });
    await jest.advanceTimersByTimeAsync(50);
    await result;
    budget.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('主动取消和超时分开，取消后新等待立即拒绝', async () => {
    const parent = new AbortController();
    const budget = createRefreshBudget(1000, parent.signal);
    parent.abort();
    await expect(waitForRefresh(1000, budget.signal)).rejects.toMatchObject({
      refreshErrorCode: 'REQUEST_CANCELLED',
    });
    budget.dispose();
  });

  test('正常结束清理预算及父信号监听', async () => {
    jest.useFakeTimers();
    const parent = new AbortController();
    const budget = createRefreshBudget(1000, parent.signal);
    const waiting = waitForRefresh(5, budget.signal);
    await jest.advanceTimersByTimeAsync(5);
    await waiting;
    budget.dispose();
    parent.abort();
    expect(budget.signal.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});
