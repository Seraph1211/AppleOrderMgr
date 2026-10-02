const {
  transition,
  displayStatus,
  productDetails,
  validProductRow,
  parseFilters,
  validateConfig,
  DEFAULT_CONFIG,
  isSilent,
  buildTasks,
} = require('../src/services/inventoryPolicy');
const { reserveProduction, settleProduction } = require('../src/services/inventoryGuardPolicy');
const config = { ...DEFAULT_CONFIG, enabled: true };
const now = 1800000000000;
const row = { sku: 'MG724CH/A', storeCode: 'R320', status: 'in_stock' };
const old = { ...row, status: 'out_of_stock', observedAt: now - 1000, expiresAt: now + 1000 };
describe('库存语义与展示', () => {
  test('首次、有货持续、无货到货、中断恢复各自独立', () => {
    expect(transition(null, row, now, 300).kind).toBe('first');
    expect(transition(old, row, now, 300).kind).toBe('arrival');
    expect(transition({ ...old, status: 'in_stock' }, row, now, 300).kind).toBeNull();
    expect(transition({ ...old, error: 'TIMEOUT' }, row, now, 300).kind).toBe('recovery');
    expect(
      transition({ ...old, status: 'in_stock', error: 'TIMEOUT' }, row, now, 300).kind
    ).toBeNull();
    expect(transition({ ...old, status: 'in_stock', expiresAt: now }, row, now, 300).kind).toBe(
      'recovery'
    );
    expect(
      transition(
        { ...old, status: 'in_stock', hardInterrupted: true, interrupted: true },
        row,
        now,
        300
      ).kind
    ).toBe('recovery');
    expect(transition(old, { ...row, status: 'out_of_stock' }, now, 300).kind).toBeNull();
    expect(() => transition(old, { ...row, status: 'unknown' }, now, 300)).toThrow();
  });
  test('成功时固化有效期，页面周期改变不刷新旧记录', () => {
    const snapshot = transition(null, row, now, 300).snapshot;
    expect(snapshot.expiresAt).toBe(now + 600000);
    expect(displayStatus(snapshot, { enabled: true }, now + 600001)).toBe('stale');
  });
  test.each([
    [null, { enabled: true }, 'unknown'],
    [old, { enabled: false }, 'disabled'],
    [old, { enabled: true, supported: false }, 'unsupported'],
    [old, { enabled: true, paused: true }, 'paused'],
    [{ ...old, error: 'TIMEOUT' }, { enabled: true }, 'error'],
    [{ ...old, expiresAt: now }, { enabled: true }, 'stale'],
    [old, { enabled: true }, 'out_of_stock'],
  ])('状态优先级 %#', (snapshot, ctx, result) =>
    expect(displayStatus(snapshot, ctx, now)).toBe(result)
  );
  test('目录精确规格映射及未知标题拒绝', () => {
    const product = productDetails({ sku: 'MG724CH/A', title: 'iPhone 17 512GB Black' });
    expect(validProductRow({ sku: product.sku, title: 'iPhone 17 512GB 黑色' }, product)).toBe(
      true
    );
    for (const title of [
      'iPhone 17 256GB 黑色',
      'iPhone 18 512GB 黑色',
      'iPhone 17 512GB 白色',
      'Not a phone',
    ])
      expect(validProductRow({ sku: product.sku, title }, product)).toBe(false);
  });
  test('筛选、配置严格校验', () => {
    expect(parseFilters({ cities: '北京,北京', colors: ['黑色'] })).toEqual({
      city: ['北京'],
      color: ['黑色'],
    });
    expect(() => parseFilters({ skus: 123 })).toThrow();
    expect(() => validateConfig({ enabled: 'true' })).toThrow();
    expect(() => validateConfig({ hourlyRequests: 0 })).toThrow();
    expect(() => validateConfig({ sneaky: true })).toThrow();
    expect(() => validateConfig({ silentStart: '22:00' })).toThrow();
    expect(validateConfig({ enabled: true }).intervalSeconds).toBe(300);
  });
  test.each([
    ['2026-10-02T15:00:00Z', true],
    ['2026-10-02T22:00:00Z', true],
    ['2026-10-02T03:00:00Z', false],
  ])('跨日北京时间静默 %s', (time, value) =>
    expect(isSilent({ silentStart: '22:00', silentEnd: '07:00' }, Date.parse(time))).toBe(value)
  );
  test('固定计划不以少量门店响应缩分母', () => {
    expect(
      buildTasks(
        Array.from({ length: 65 }, (_, i) => ({ sku: String(i) })),
        [{ storeCode: 'R320' }]
      )
    ).toHaveLength(78);
    expect(buildTasks([{ sku: 'X' }], [])).toHaveLength(0);
  });
});
describe('生产保护与费用上限', () => {
  test.each([
    [{ pausedReason: 'MANUAL' }, 'MANUAL'],
    [{ cooldownUntil: now + 1000 }, 'TARGET_COOLDOWN'],
    [{ pausedEgress: { main: 'AUTH' } }, 'AUTH'],
    [{ requiredAlternateEgress: 'main' }, 'ALTERNATE_EGRESS_REQUIRED'],
    [{ hour: Math.floor(now / 3600000), hourCount: 1200 }, 'REQUEST_BUDGET_EXHAUSTED'],
    [{ day: Math.floor(now / 86400000), byteCount: config.dailyBytes }, 'REQUEST_BUDGET_EXHAUSTED'],
  ])('请求拒绝保留状态 %#', (state, blocked) =>
    expect(reserveProduction(state, now, 'id', 0, 'main', 'inventory', config).blocked).toBe(
      blocked
    )
  );
  test('串行许可、抖动、预算跨出口与重启不清空', () => {
    const { state } = reserveProduction({}, now, 'id', 100, 'main', 'inventory', config);
    expect(state.hourCount).toBe(1);
    expect(state.nextAt).toBe(now + 1100);
    expect(
      reserveProduction(state, now + 1, 'id2', 0, 'backup', 'inventory', config).waitMs
    ).toBeGreaterThan(0);
    const finished = settleProduction(
      state,
      { id: 'id', egress: 'main', purpose: 'inventory', outcome: 'INVENTORY_VALID', bytes: 100 },
      now + 10
    );
    expect(finished.byteCount).toBe(100);
    expect(finished.hourCount).toBe(1);
  });
  test('代理提取不能清零 Apple 风险，且有独立提取预算', () => {
    const state = settleProduction(
      { consecutiveRisks: 2 },
      { purpose: 'provider', outcome: 'PROVIDER_ENDPOINT_RECEIVED' },
      now
    );
    expect(state.consecutiveRisks).toBe(2);
    expect(
      reserveProduction(
        { day: Math.floor(now / 86400000), proxyCount: 400 },
        now,
        'id',
        0,
        'yiyou-provider',
        'provider',
        config
      ).blocked
    ).toBe('REQUEST_BUDGET_EXHAUSTED');
    expect(
      settleProduction(state, { purpose: 'provider', outcome: 'PROVIDER_FAILED' }, now).pausedReason
    ).toBe('PROVIDER_FAILED');
  });
  test('429 尊重长 Retry-After；541 冷却仍要求不同已配置出口', () => {
    const state = settleProduction(
      {},
      { purpose: 'inventory', egress: 'main', outcome: 'TARGET_REJECTED', retryMs: 900000 },
      now
    );
    expect(state.cooldownUntil).toBe(now + 900000);
    expect(state.requiredAlternateEgress).toBe('main');
    expect(
      reserveProduction(state, now + 1000, 'id', 0, 'backup', 'inventory', config).blocked
    ).toBe('TARGET_COOLDOWN');
  });
  test.each(['TARGET_CHALLENGE', 'INVALID_RESPONSE', 'REDIRECT_BLOCKED', 'CATALOG_MISMATCH'])(
    '需人工处理 %s',
    outcome =>
      expect(settleProduction({}, { outcome, purpose: 'inventory' }, now).pausedReason).toBe(
        outcome
      )
  );
  test('三次、风险比例与双出口阈值暂停十分钟', () => {
    expect(
      settleProduction(
        { consecutiveRisks: 2 },
        { outcome: 'TARGET_RATE_LIMITED', egress: 'main' },
        now
      ).cooldownUntil
    ).toBe(now + 600000);
    const recent = Array.from({ length: 19 }, (_, i) => ({
      at: now - 1000,
      risk: i < 3,
      egress: 'main',
    }));
    expect(
      settleProduction({ recent }, { outcome: 'TARGET_RATE_LIMITED', egress: 'main' }, now)
        .cooldownUntil
    ).toBe(now + 600000);
    expect(
      settleProduction(
        { recent: [{ at: now, risk: true, egress: 'backup' }] },
        { outcome: 'TARGET_REJECTED', egress: 'main' },
        now
      ).cooldownUntil
    ).toBe(now + 600000);
  });
  test('恢复三次失败后停；三次有效库存才恢复，目录成功不算', () => {
    let state = { recovering: true };
    for (let i = 0; i < 3; i += 1)
      state = settleProduction(
        state,
        { purpose: 'inventory', outcome: 'UPSTREAM_ERROR' },
        now + i * 3000000
      );
    expect(state.pausedReason).toBe('RECOVERY_EXHAUSTED');
    state = { recovering: true };
    state = settleProduction(state, { purpose: 'catalog', outcome: 'CATALOG_RECEIVED' }, now);
    expect(state.recoverySuccesses).toBeUndefined();
    for (let i = 0; i < 3; i += 1)
      state = settleProduction(
        state,
        { purpose: 'inventory', outcome: 'INVENTORY_VALID' },
        now + i * 5000
      );
    expect(state.recovering).toBe(false);
  });
  test('连续普通 5xx 单列异常冷却，不计为 Apple 风控', () => {
    let state = {};
    for (let i = 0; i < 5; i += 1)
      state = settleProduction(
        state,
        { purpose: 'inventory', outcome: 'UPSTREAM_ERROR', egress: 'main' },
        now
      );
    expect(state.cooldownUntil).toBe(now + 600000);
    expect(state.recent.filter(r => r.risk)).toHaveLength(0);
  });
});
