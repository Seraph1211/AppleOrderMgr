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
  status: 'payment_due',
  paymentStatus: 'unpaid',
  validationStatus: 'valid',
};

describe('订单刷新策略', () => {
  test.each(['unknown', 'unpaid', null])(
    '明确待付款阶段支付字段 %s 每分钟参与自动刷新',
    paymentStatus => {
      const from = new Date('2026-09-07T00:00:00Z');
      const order = { ...BASE_ORDER, paymentStatus };

      expect(isAutoRefreshEligible(order)).toBe(true);
      expect(getNextAutoRefreshAt(order, from).getTime() - from.getTime()).toBe(
        AUTO_REFRESH_INTERVAL_MS
      );
    }
  );

  test.each([
    [{ ...BASE_ORDER, paymentStatus: 'paid' }, 'paid'],
    [{ ...BASE_ORDER, paymentStatus: 'refunded' }, 'refunded'],
    [{ ...BASE_ORDER, status: 'completed' }, 'terminal'],
    [
      {
        ...BASE_ORDER,
        validationStatus: 'abnormal',
        validationIssues: [{ type: 'order_identity' }],
      },
      'identity',
    ],
    [{ ...BASE_ORDER, orderUrl: null }, 'missing URL'],
  ])('%s 不参与分钟级自动刷新（%s）', (order, _reason) => {
    expect(isAutoRefreshEligible(order)).toBe(false);
    expect(getNextAutoRefreshAt(order)).toBeNull();
  });

  test.each(['processing', 'ready_for_pickup', 'shipped', 'payment_received', 'completed'])(
    '历史 %s 即使支付字段为空或误为 unpaid 也不自动刷新',
    status => {
      for (const paymentStatus of [null, '', 'unknown', 'unpaid']) {
        expect(isAutoRefreshEligible({ ...BASE_ORDER, status, paymentStatus })).toBe(false);
      }
    }
  );

  test.each([null, '', 'unknown'])(
    '新单支付 %s 仅在来源下单时间的 30 分钟内自动核实',
    paymentStatus => {
      const order = {
        ...BASE_ORDER,
        status: 'pending',
        paymentStatus,
        orderDate: '2026-09-09T00:00:00Z',
      };
      expect(isAutoRefreshEligible(order, new Date('2026-09-09T00:29:59Z'))).toBe(true);
      expect(isAutoRefreshEligible(order, new Date('2026-09-09T00:30:00Z'))).toBe(false);
      expect(getNextAutoRefreshAt(order, new Date('2026-09-09T01:00:00Z'))).toBeNull();
      expect(
        isAutoRefreshEligible(
          { ...order, createdAt: '2026-09-09T01:00:00Z' },
          new Date('2026-09-09T01:00:00Z')
        )
      ).toBe(false);
    }
  );

  test.each([undefined, null, 'invalid', '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z'])(
    '未知支付的时间 %s 无法证明当前付款窗口时不自动刷新',
    orderDate => {
      expect(
        isAutoRefreshEligible(
          { ...BASE_ORDER, status: 'unknown', paymentStatus: null, orderDate },
          new Date('2026-09-09T00:00:00Z')
        )
      ).toBe(false);
    }
  );

  test('未知支付优先官网截止，缺少来源时间时兼容新建时间', () => {
    const now = new Date('2026-09-09T00:00:00Z');
    const order = { ...BASE_ORDER, status: 'pending', paymentStatus: null, createdAt: now };
    expect(isAutoRefreshEligible(order, now)).toBe(true);
    expect(isAutoRefreshEligible({ ...order, officialPaymentExpiresAt: now }, now)).toBe(false);
    expect(
      isAutoRefreshEligible(
        { ...order, orderDate: '2020-01-01', officialPaymentExpiresAt: '2026-09-09T00:01:00Z' },
        now
      )
    ).toBe(true);
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
