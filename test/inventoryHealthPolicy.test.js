const { healthProjection, WAIT_REASONS } = require('../src/services/inventoryHealthPolicy');
const now = 1800000000000;
const runtime = { workerHeartbeat: now, lastSuccessAt: now - 1000 };
const config = { enabled: true };
const coverage = { expected: 784, fresh: 49, inStock: 3 };

test('旧代理停用不阻断当前来源；当前来源阻断需要人工处理', () => {
  expect(
    healthProjection(runtime, { pausedEgress: { 'fanproxy-main': 'AUTH' } }, config, now, coverage)
      .state
  ).toBe('normal');
  expect(
    healthProjection(
      runtime,
      { pausedEgress: { 'iproyal-main': 'PROXY_RECOVERY_EXHAUSTED' } },
      config,
      now,
      coverage
    )
  ).toMatchObject({ state: 'manual_required', actionRequired: true, automaticWait: false });
});
test('冷却、恢复和换出口可等待，不承诺等待能解除人工或离线状态', () => {
  expect(
    healthProjection(runtime, { providerCooldownUntil: now + 1000 }, config, now, coverage)
  ).toMatchObject({ state: 'automatic_wait', waitUntil: now + 1000, automaticWait: true });
  expect(
    healthProjection(runtime, { cooldownUntil: now + 1000 }, config, now, coverage).state
  ).toBe('cooldown');
  expect(healthProjection(runtime, { recovering: true }, config, now, coverage).state).toBe(
    'recovering'
  );
  expect(
    healthProjection(
      { ...runtime, workerHeartbeat: now - 120001 },
      { recovering: true },
      config,
      now,
      coverage
    ).state
  ).toBe('offline');
  expect(WAIT_REASONS.has('PROXY_RECOVERY_EXHAUSTED')).toBe(false);
});
test('数据失效与无货独立，停采时间只采用已有证据', () => {
  expect(
    healthProjection(runtime, {}, config, now, { expected: 784, fresh: 0, inStock: 0 })
  ).toMatchObject({ state: 'data_stale', dataStale: true, stoppedAt: null });
  expect(
    healthProjection(runtime, {}, config, now, { expected: 784, fresh: 784, inStock: 0 }).state
  ).toBe('normal');
  expect(
    healthProjection({ ...runtime, stoppedAt: now - 100 }, {}, config, now, coverage).stoppedAt
  ).toBe(now - 100);
  expect(healthProjection(runtime, {}, { enabled: false }, now, coverage).state).toBe('disabled');
});

test('预算耗尽等待桶自然重置，不要求人工恢复且显示实际桶时间', () => {
  const hour = Math.floor(now / 3600000);
  const day = Math.floor(now / 86400000);
  const limits = {
    enabled: true,
    hourlyRequests: 1200,
    dailyRequests: 25000,
    dailyBytes: 536870912,
    dailyProxyExtractions: 400,
  };
  const source = { ...runtime, lastError: 'REQUEST_BUDGET_EXHAUSTED' };
  expect(healthProjection(source, { hour, hourCount: 1200 }, limits, now, coverage)).toMatchObject({
    state: 'automatic_wait',
    actionRequired: false,
    waitUntil: (hour + 1) * 3600000,
  });
  expect(healthProjection(source, { day, dayCount: 25000 }, limits, now, coverage).waitUntil).toBe(
    (day + 1) * 86400000
  );
  expect(
    healthProjection(source, { hour: hour - 1, hourCount: 1200 }, limits, now, coverage).waitUntil
  ).toBeNull();
});
