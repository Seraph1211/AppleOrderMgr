const {
  AUTO_REFRESH_INTERVAL_MS,
  getDisplayedFreshness,
  getNextAutoRefreshAt,
  getRefreshPriority,
  isAutoRefreshEligible,
} = require('../src/services/crawler/refreshPolicy');

const BASE_ORDER = {
  orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W123/test%40example.com',
  autoRefreshEnabled: true,
  status: 'processing',
  paymentStatus: 'unknown',
  validationStatus: 'valid',
};

describe('订单刷新策略', () => {
  test.each(['unknown', 'unpaid', null])('未付款状态 %s 每分钟参与自动刷新', paymentStatus => {
    const from = new Date('2026-09-07T00:00:00Z');
    const order = { ...BASE_ORDER, paymentStatus };

    expect(isAutoRefreshEligible(order)).toBe(true);
    expect(getNextAutoRefreshAt(order, from).getTime() - from.getTime()).toBe(
      AUTO_REFRESH_INTERVAL_MS
    );
  });

  test.each([
    [{ ...BASE_ORDER, paymentStatus: 'paid' }, 'paid'],
    [{ ...BASE_ORDER, paymentStatus: 'refunded' }, 'refunded'],
    [{ ...BASE_ORDER, status: 'completed' }, 'terminal'],
    [{ ...BASE_ORDER, validationStatus: 'abnormal' }, 'abnormal'],
    [{ ...BASE_ORDER, orderUrl: null }, 'missing URL'],
  ])('%s 不参与分钟级自动刷新（%s）', (order, _reason) => {
    expect(isAutoRefreshEligible(order)).toBe(false);
    expect(getNextAutoRefreshAt(order)).toBeNull();
  });

  test('人工单单、逾期自动、普通自动、页面和人工全量按优先级排序', () => {
    expect(getRefreshPriority('manual_single')).toBeGreaterThan(getRefreshPriority('auto', true));
    expect(getRefreshPriority('auto', true)).toBeGreaterThan(getRefreshPriority('auto'));
    expect(getRefreshPriority('auto')).toBeGreaterThan(getRefreshPriority('page_open'));
    expect(getRefreshPriority('page_open')).toBeGreaterThan(getRefreshPriority('manual_all'));
  });

  test('刷新超过新鲜度窗口后显示 stale', () => {
    const now = new Date('2026-09-07T00:02:00Z');
    const schedule = {
      freshnessStatus: 'fresh',
      lastSuccessAt: new Date('2026-09-07T00:00:00Z'),
    };

    expect(getDisplayedFreshness(schedule, BASE_ORDER, now)).toBe('stale');
  });
});
