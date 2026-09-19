const {
  getPaymentDeadline,
  assessAssignment,
  isAssignmentBlocked,
} = require('../src/services/paymentEligibility');
const order = {
  orderDate: '2026-09-19T21:38:00+08:00',
  orderNumber: 'W123',
  orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W123/synthetic',
  status: 'pending',
};
const task = { id: 1, orderId: 2, version: 0, processingStatus: 'pending', order };
const now = new Date('2026-09-19T14:00:00Z');
test('来源加30分钟；跨日期；官网及历史截止均不覆盖', () => {
  expect(getPaymentDeadline({ ...order, officialPaymentExpiresAt: now }).toISOString()).toBe(
    '2026-09-19T14:08:00.000Z'
  );
  expect(getPaymentDeadline({ orderDate: '2026-12-31T23:50:00+08:00' }).toISOString()).toBe(
    '2026-12-31T16:20:00.000Z'
  );
});
test.each([null, '', '2026-09-19', 'bad', '2026-09-19T20:00:00', new Date(NaN)])(
  '无精确来源时间不回退官网 %s',
  value => {
    expect(getPaymentDeadline({ orderDate: value, officialOrderCreatedAt: now })).toBeNull();
  }
);
test('身份异常、未知状态与待核实仅提示，手动及自动均不拦截', () => {
  const flagged = {
    ...order,
    status: 'unknown',
    officialStatusNeedsReview: true,
    validationIssues: [{ type: 'order_identity' }],
  };
  expect(isAssignmentBlocked(flagged)).toBe(false);
  const result = assessAssignment({ ...task, order: flagged }, 0, now);
  expect(result.eligible).toBe(true);
  expect(result.warnings).toHaveLength(2);
});
test.each([
  { paymentStatus: 'paid' },
  { paymentStatus: 'refunded' },
  { status: 'cancelled' },
  { status: 'processing' },
  { status: 'delivered' },
])('明确终态仍阻止分配 %j', patch => {
  expect(assessAssignment({ ...task, order: { ...order, ...patch } }, 0, now)).toMatchObject({
    eligible: false,
    code: 'PAYMENT_NOT_ELIGIBLE',
  });
});
test('手动允许过期，自动不允许官网明确过期', () => {
  const expired = { ...order, status: 'payment_expired' };
  expect(assessAssignment({ ...task, order: expired }, 0, new Date('2026-09-20')).eligible).toBe(
    true
  );
  expect(isAssignmentBlocked(expired)).toBe(true);
});
test('链接、版本和人工完成仍校验并给出解决方法', () => {
  expect(assessAssignment(task, 1, now).code).toBe('CONCURRENT_MODIFICATION');
  expect(assessAssignment({ ...task, processingStatus: 'completed' }, 0, now).code).toBe(
    'INVALID_STATE'
  );
  const result = assessAssignment(
    {
      ...task,
      order: { ...order, orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W999/synthetic' },
    },
    0,
    now
  );
  expect(result.code).toBe('PAYMENT_LINK_INVALID');
  expect(result.solution).toContain('链接');
});

test('全部商品终态仍拦截，付款过期保留手动交接例外', () => {
  expect(isAssignmentBlocked({ status: 'unknown', officialAllItemsTerminal: true }, true)).toBe(true);
  expect(isAssignmentBlocked({ status: 'payment_expired', officialAllItemsTerminal: true }, true)).toBe(false);
});
