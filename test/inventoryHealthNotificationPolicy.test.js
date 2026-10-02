const {
  healthObservation,
  observeHealth,
  canQueueHealth,
  settleHealth,
} = require('../src/services/inventoryHealthNotificationPolicy');
const settings = {
  destinationId: 'dest',
  webhookCipher: 'encrypted',
  config: { enabled: true, notificationsEnabled: true },
};
const degraded = healthObservation({ lastError: 'TRANSPORT_UNKNOWN' }, {}, 0);
const normal = healthObservation({}, {}, 0);
const observe = (state, observation, now) => observeHealth(state, observation, settings, now);

test('短暂错误不通知；交替传输错误保持同一持续窗口，恰好 2 分钟触发', () => {
  const first = observe(null, degraded, 1000);
  expect(first.desiredKey).toBeNull();
  const readFailed = healthObservation({ lastError: 'RESPONSE_READ_FAILED' }, {}, 2000);
  const second = observe(first.state, readFailed, 120999);
  expect(second.desiredKey).toBeNull();
  expect(second.state.since).toBe(1000);
  expect(observe(second.state, readFailed, 121000).desiredKey).toBe('degraded');
  expect(observe(first.state, normal, 5000).desiredKey).toBeNull();
});
test('稳定恢复必须关联已发故障；中途失败重新计时且恢复只提醒一次', () => {
  let { state } = observe(null, degraded, 0);
  expect(observe(state, normal, 200000).desiredKey).toBeNull();
  state = settleHealth(state, {
    healthVersion: 1,
    healthKey: 'degraded',
    destinationId: 'dest',
    status: 'accepted',
  });
  state = observe(state, normal, 200000).state;
  expect(observe(state, normal, 319999).desiredKey).toBeNull();
  expect(observe(state, normal, 320000).desiredKey).toBe('normal');
  state = observe(state, degraded, 300000).state;
  state = observe(state, normal, 310000).state;
  expect(observe(state, normal, 320000).desiredKey).toBeNull();
  state = settleHealth(state, {
    healthVersion: 1,
    healthKey: 'normal',
    destinationId: 'dest',
    status: 'accepted',
  });
  expect(observe(state, normal, 500000).desiredKey).toBeNull();
});
test.each(['accepted', 'unknown', 'failed'])('投递 %s 的恢复关联及重启持久化', status => {
  let { state } = observe(null, degraded, 0);
  state = settleHealth(state, {
    healthVersion: 1,
    healthKey: 'degraded',
    destinationId: 'dest',
    status,
  });
  const restored = observe(JSON.parse(JSON.stringify(state)), normal, 1000).state;
  expect(observe(restored, normal, 121000).desiredKey).toBe(status === 'failed' ? null : 'normal');
});
test('同类故障 30 分钟边界，其他严重故障不被普通故障限流', () => {
  let { state } = observe(null, degraded, 0);
  state.lastAttempts.degraded = 1000;
  expect(canQueueHealth(state, 'degraded', 1800999)).toBe(false);
  expect(canQueueHealth(state, 'degraded', 1801000)).toBe(true);
  expect(canQueueHealth(state, 'manual:INVALID_STRUCTURE', 2000)).toBe(true);
  expect(canQueueHealth(state, 'normal', 2000)).toBe(true);
});
test.each([
  [{ pausedReason: 'INVALID_STRUCTURE' }, {}, 'manual:INVALID_STRUCTURE'],
  [{ cooldownUntil: 9000 }, {}, 'cooldown'],
  [{}, { lastError: 'NO_HEALTHY_PROXY' }, 'urgent:NO_HEALTHY_PROXY'],
  [{}, { lastError: 'REQUEST_BUDGET_EXHAUSTED' }, 'urgent:REQUEST_BUDGET_EXHAUSTED'],
])('严重状态立即提醒 %#', (guard, runtime, key) => {
  expect(observe(null, healthObservation(runtime, guard, 1000), 1000).desiredKey).toBe(key);
});
test('关闭、机器人切换和旧版本不补发历史恢复；旧目标回执不污染新状态', () => {
  const previous = {
    version: 1,
    destinationId: 'dest',
    observedKey: 'normal',
    since: 0,
    announcedKey: 'degraded',
    lastAttempts: {},
  };
  for (const config of [
    { ...settings, destinationId: 'new' },
    { ...settings, config: { enabled: false, notificationsEnabled: true } },
    { ...settings, config: { enabled: true, notificationsEnabled: false } },
  ]) {
    const result = observeHealth(previous, normal, config, 999999);
    expect(result.desiredKey).toBeNull();
    expect(result.state.announcedKey).toBeNull();
  }
  expect(observe({ ...previous, version: 0 }, normal, 999999).desiredKey).toBeNull();
  let { state } = observe(null, normal, 0);
  state = settleHealth(state, {
    healthVersion: 1,
    healthKey: 'degraded',
    destinationId: 'old',
    status: 'accepted',
  });
  expect(state.announcedKey).toBeNull();
});

test('恢复通知明确失败也有重试间隔，新故障送达后允许下一次稳定恢复', () => {
  let { state } = observe(null, degraded, 0);
  state.lastAttempts.normal = 1000;
  expect(canQueueHealth(state, 'normal', 2000)).toBe(false);
  state = settleHealth(state, {
    healthVersion: 1,
    healthKey: 'manual:INVALID_STRUCTURE',
    destinationId: 'dest',
    status: 'accepted',
  });
  expect(canQueueHealth(state, 'normal', 2000)).toBe(true);
});
