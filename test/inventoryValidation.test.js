const {
  reserveBudget,
  settleBudget,
  retryAfterMs,
  classifyResponse,
  parsePickupResponse,
  LIMITS,
} = require('../src/services/inventoryValidationPolicy');
const { targetFor } = require('../src/services/inventoryValidationClient');

const NOW = Date.parse('2026-10-02T12:00:00Z');
const SKU = 'TEST1CH/A';
const store = (display = 'available') => ({
  storeNumber: 'R001',
  storeName: '合成门店',
  city: '合成城市',
  partsAvailability: {
    [SKU]: {
      pickupDisplay: display,
      storePickEligible: true,
      messageTypes: { regular: { storePickupProductTitle: 'iPhone 测试 256GB' } },
    },
  },
});

describe('库存前置探测保护', () => {
  test('预占预算、请求租约和抖动跨进程共享', () => {
    const first = reserveBudget({}, NOW, 'a', 100).state;
    expect(first.hourCount).toBe(1);
    expect(first.dayCount).toBe(1);
    expect(first.nextAt).toBe(NOW + 1100);
    expect(reserveBudget(first, NOW, 'b').waitMs).toBe(LIMITS.leaseMs);
    const done = settleBudget(
      first,
      { id: 'a', outcome: 'REQUEST_TIMEOUT', egress: 'main' },
      NOW + 500
    );
    expect(done.hourCount).toBe(1);
    expect(reserveBudget(done, NOW + 500, 'b').waitMs).toBe(600);
    expect(reserveBudget(done, NOW + 1200, 'b').state.hourCount).toBe(2);
  });
  test('小时／日额度到顶后禁止请求，日切换恢复窗口但不清除暂停', () => {
    const state = {
      hour: NOW / 3600000,
      day: Math.floor(NOW / 86400000),
      hourCount: 60,
      dayCount: 60,
    };
    expect(reserveBudget(state, NOW, 'a').blocked).toBe('REQUEST_BUDGET_EXHAUSTED');
    expect(reserveBudget({ ...state, hourCount: 0, dayCount: 300 }, NOW, 'a').blocked).toBe(
      'REQUEST_BUDGET_EXHAUSTED'
    );
    expect(reserveBudget(state, NOW + 86400000, 'a').state.dayCount).toBe(1);
    expect(
      reserveBudget({ ...state, pausedReason: 'TARGET_CHALLENGE' }, NOW + 86400000, 'a').blocked
    ).toBe('TARGET_CHALLENGE');
  });
  test('407只隔离失败出口，其他出口仍受全局预算约束', () => {
    const state = settleBudget({}, { id: 'a', outcome: 'PROXY_AUTH_FAILED', egress: 'main' }, NOW);
    expect(reserveBudget(state, NOW, 'b', 0, 'main').blocked).toBe('PROXY_AUTH_FAILED');
    expect(reserveBudget(state, NOW, 'b', 0, 'other').state).toBeDefined();
  });
  test('541换出口仍需冷却，原出口不能立即重用', () => {
    const state = settleBudget({}, { id: 'a', outcome: 'TARGET_REJECTED', egress: 'main' }, NOW);
    expect(reserveBudget(state, NOW, 'b', 0, 'main').blocked).toBe('ALTERNATE_EGRESS_REQUIRED');
    expect(reserveBudget(state, NOW, 'b', 0, 'backup').blocked).toBe('TARGET_COOLDOWN');
    expect(reserveBudget(state, NOW + 60001, 'b', 0, 'backup').state).toBeDefined();
  });
  test('长 Retry-After 和连续风险／双出口风险触发全局暂停', () => {
    let state = settleBudget(
      {},
      { outcome: 'TARGET_RATE_LIMITED', egress: 'a', retryMs: 7200000 },
      NOW
    );
    expect(state.cooldownUntil).toBe(NOW + 7200000);
    state = {};
    for (let i = 0; i < 3; i++)
      state = settleBudget(state, { outcome: 'TARGET_REJECTED', egress: 'a' }, NOW);
    expect(state.cooldownUntil).toBe(NOW + 600000);
    state = settleBudget({}, { outcome: 'TARGET_REJECTED', egress: 'a' }, NOW);
    state = settleBudget(state, { outcome: 'TARGET_REJECTED', egress: 'b' }, NOW);
    expect(state.cooldownUntil).toBe(NOW + 600000);
  });
  test('403与不可解析结构持久暂停，普通5xx不冒充风控', () => {
    for (const outcome of ['TARGET_CHALLENGE', 'INVALID_RESPONSE', 'REDIRECT_BLOCKED']) {
      const state = settleBudget({}, { outcome, egress: 'a' }, NOW);
      expect(reserveBudget(state, NOW + 86400000, 'b').blocked).toBe(outcome);
    }
    expect(
      settleBudget({}, { outcome: 'UPSTREAM_ERROR', egress: 'a' }, NOW).pausedReason
    ).toBeUndefined();
  });
  test.each([
    [407, 'PROXY_AUTH_FAILED'],
    [429, 'TARGET_RATE_LIMITED'],
    [541, 'TARGET_REJECTED'],
    [403, 'TARGET_CHALLENGE'],
    [302, 'REDIRECT_BLOCKED'],
    [500, 'UPSTREAM_ERROR'],
    [503, 'UPSTREAM_ERROR'],
    [404, 'HTTP_ERROR'],
  ])('状态%d准确分类', (status, expected) => {
    expect(classifyResponse(status)).toBe(expected);
  });
  test('Retry-After秒数、日期、非法值', () => {
    expect(retryAfterMs('120', NOW)).toBe(120000);
    expect(retryAfterMs('Fri, 02 Oct 2026 12:02:00 GMT', NOW)).toBe(120000);
    expect(retryAfterMs('invalid', NOW)).toBe(0);
    expect(retryAfterMs(undefined, NOW)).toBe(0);
    expect(retryAfterMs('-3', NOW)).toBe(0);
  });
});

describe('库存响应完整性', () => {
  test.each([
    ['available', 'in_stock'],
    ['unavailable', 'out_of_stock'],
    ['unknown', 'unknown'],
  ])('支持取货不等于有货：%s', (raw, status) => {
    expect(parsePickupResponse({ body: { stores: [store(raw)] } }, [SKU])[0].status).toBe(status);
  });
  test('缺SKU不拿另一商品替代；缺标题不认定成功', () => {
    const s = store();
    delete s.partsAvailability[SKU];
    s.partsAvailability.OTHERCH = { pickupDisplay: 'available' };
    expect(parsePickupResponse({ body: { stores: [s] } }, [SKU])[0].status).toBe('unknown');
  });
  test.each(['<html>challenge</html>', {}, { body: { stores: [] } }])('非法结构拒绝', input => {
    expect(() => parsePickupResponse(input, [SKU])).toThrow();
  });
  test('重复门店一致去重，冲突拒绝', () => {
    expect(parsePickupResponse({ body: { stores: [store(), store()] } }, [SKU])).toHaveLength(1);
    expect(() =>
      parsePickupResponse({ body: { stores: [store(), store('unavailable')] } }, [SKU])
    ).toThrow('CONFLICTING_DUPLICATE_STORE');
  });
  test('固定目标防止任意URL及参数注入', () => {
    expect(targetFor('inventory', { skus: [SKU], location: '100000' })).toContain(
      'parts.0=TEST1CH/A&location=100000'
    );
    expect(() => targetFor('inventory', { skus: ['X&bad=1'], location: '100000' })).toThrow();
    expect(() => targetFor('catalog', { path: '/shop/buy-iphone?bad=1' })).toThrow();
    expect(() => targetFor('catalog', { path: '//evil.test/' })).toThrow();
    expect(() => targetFor('unknown', {})).toThrow();
  });
});
