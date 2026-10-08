const { reserveProduction, settleProduction } = require('../src/services/inventoryGuardPolicy');
const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
const config = { ...DEFAULT_CONFIG, enabled: true };
const now = 1790989200000;
const reserve = (state, at, id, purpose = 'inventory') =>
  reserveProduction(state, at, id, 0, 'main', purpose, config);
const finish = (state, id, at, outcome = 'INVENTORY_VALID', bytes = 100) =>
  settleProduction(state, { id, purpose: 'inventory', egress: 'main', outcome, bytes }, at);

test('跨请求最多三并发，仍按 1 RPS 发起；乱序完成分别释放租约与字节预占', () => {
  let state = reserve({}, now, 'a').state;
  expect(reserve(state, now + 999, 'b').waitMs).toBe(1);
  state = reserve(state, now + 1000, 'b').state;
  state = reserve(state, now + 2000, 'c').state;
  expect(Object.keys(state.requestLeases)).toHaveLength(3);
  expect(state.hourCount).toBe(3);
  expect(reserve(state, now + 3000, 'd').waitMs).toBeGreaterThan(0);
  state = finish(state, 'b', now + 3100);
  expect(Object.keys(state.requestLeases)).toEqual(['a', 'c']);
  expect(state.byteCount).toBe(2 * 5242880 + 100);
  state = reserve(state, now + 3200, 'd').state;
  for (const id of ['d', 'c', 'a']) state = finish(state, id, now + 5000);
  expect(state.byteCount).toBe(400);
  expect(state.hourCount).toBe(4);
  expect(Object.keys(state.requestLeases)).toHaveLength(0);
});
test('旧租约、恢复探测和目录请求保持互斥，重启不放大并发', () => {
  expect(reserve({ leaseId: 'old', leaseUntil: now + 45000 }, now, 'a').waitMs).toBe(45000);
  let state = reserve({ recovering: true }, now, 'a').state;
  expect(reserve(JSON.parse(JSON.stringify(state)), now + 1100, 'b').waitMs).toBeGreaterThan(0);
  state = reserve({}, now, 'a', 'catalog').state;
  expect(reserve(state, now + 1100, 'b').waitMs).toBeGreaterThan(0);
  state = reserve({}, now, 'a').state;
  expect(reserve(state, now + 1100, 'b', 'provider').waitMs).toBeGreaterThan(0);
});
test('暂停后旧请求成功不能计作恢复，当前恢复必须持有对应时期的许可', () => {
  let state = reserve({}, now, 'a').state;
  state = reserve(state, now + 1000, 'b').state;
  state = finish(state, 'a', now + 2000, 'TARGET_RATE_LIMITED');
  expect(state.recovering).toBe(true);
  expect(reserve(state, now + 3000, 'c').blocked).toBe('TARGET_COOLDOWN');
  state = finish(state, 'b', now + 4000);
  expect(state.recoverySuccesses).toBe(0);
  state = reserve(state, now + 63000, 'c').state;
  state = finish(state, 'c', now + 64000);
  expect(state.recoverySuccesses).toBe(1);
  expect(state.recovering).toBe(true);
});
test('每个并发请求预占预算；未知到期不退费，迟到和跨日结算不扣新日预算', () => {
  let state = reserve({}, now, 'a').state;
  const tiny = { ...config, dailyBytes: 5242880 + 1 };
  expect(reserveProduction(state, now + 2000, 'b', 0, 'main', 'inventory', tiny).blocked).toBe(
    'REQUEST_BUDGET_EXHAUSTED'
  );
  state = reserve(state, now + 46000, 'b').state;
  expect(state.byteCount).toBe(2 * 5242880);
  expect(Object.keys(state.requestLeases)).toEqual(['b']);
  state = finish(state, 'a', now + 47000);
  expect(state.byteCount).toBe(2 * 5242880);
  const nextDay = (Math.floor(now / 86400000) + 1) * 86400000;
  state = reserve({}, nextDay - 1000, 'old').state;
  state = reserve(state, nextDay + 100, 'new').state;
  state = finish(state, 'old', nextDay + 200);
  expect(state.byteCount).toBe(5242880);
  state = finish(state, 'new', nextDay + 300);
  expect(state.byteCount).toBe(100);
});

test('验证工具与生产在途请求共享互斥，人工恢复后旧探测不能累积成功', () => {
  const { reserveBudget } = require('../src/services/inventoryValidationPolicy');
  let state = reserve({ recovering: true, resumedAt: now - 1000 }, now, 'a').state;
  expect(reserveBudget(state, now + 2000, 'validation').waitMs).toBeGreaterThan(0);
  state.resumedAt = now + 1000;
  state = finish(state, 'a', now + 3000);
  expect(state.recoverySuccesses || 0).toBe(0);
  expect(state.recovering).toBe(true);
});
