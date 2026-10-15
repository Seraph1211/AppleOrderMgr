const inventoryFailure = require('../src/utils/inventoryFailure');
const InventoryCollector = require('../src/services/inventoryCollector');
const now = 1800000000000;

/** 合成事务只覆盖未发送等待分支，不连接数据库或真实网络。 */
function fixture(outcome) {
  const state = { activeRound: 'round', leaseOwner: 'owner', leaseUntil: now + 10000 };
  const task = {
    status: 'running',
    attempts: 0,
    claimedAt: now,
    leaseToken: 'token',
    leaseUntil: now + 10000,
  };
  const round = { id: 'round', plannedAt: now, intervalSeconds: 300, tasks: [task] };
  const service = {
    locked: async work => {
      try {
        return await work({ transaction: {}, state, settings: { config: { enabled: true } }, now });
      } catch (error) {
        throw inventoryFailure(error);
      }
    },
    rows: jest.fn().mockResolvedValue([round]),
    put: jest.fn().mockResolvedValue(),
  };
  const collector = new InventoryCollector(service, 'owner');
  return {
    state,
    task,
    service,
    run: () =>
      collector.settle(
        { roundId: 'round', taskIndex: 0, claimedAt: now, leaseToken: 'token' },
        { outcome, until: now + 1000 }
      ),
  };
}

test('普通并发容量等待不污染健康或成功快照，不增加实际尝试', async () => {
  try {
    const test = fixture('REQUEST_IN_FLIGHT');
    expect(await test.run()).toMatchObject({ deferred: true });
    expect(test.state.lastError).toBeUndefined();
    expect(test.state.stoppedAt).toBeUndefined();
    expect(test.task).toMatchObject({ status: 'pending', attempts: 0 });
    expect(test.service.put.mock.calls.map(call => call[0])).toEqual(['InventoryRound']);
  } catch (error) {
    throw inventoryFailure(error);
  }
});

test('供应商冷却在轮次截止内等待，不触碰库存快照', async () => {
  try {
    const test = fixture('PROXY_PROVIDER_COOLDOWN');
    expect(await test.run()).toMatchObject({ deferred: true });
    expect(test.state).toMatchObject({ lastError: 'PROXY_PROVIDER_COOLDOWN', stoppedAt: now });
    expect(test.task).toMatchObject({ status: 'pending', attempts: 0, notBefore: now + 1000 });
    expect(test.service.put.mock.calls.map(call => call[0])).toEqual(['InventoryRound']);
  } catch (error) {
    throw inventoryFailure(error);
  }
});

test('已有历史故障缺少起点时不把发布后观察时刻伪造为停采起点', async () => {
  try {
    const test = fixture('PROXY_PROVIDER_COOLDOWN');
    test.state.lastError = 'NO_HEALTHY_PROXY';
    await test.run();
    expect(test.state.stoppedAt).toBeNull();
    expect(test.state.lastError).toBe('PROXY_PROVIDER_COOLDOWN');
  } catch (error) { throw inventoryFailure(error); }
});
