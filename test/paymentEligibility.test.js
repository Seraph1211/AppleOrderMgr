const {
  getPaymentDeadline,
  assessAssignment,
  isAssignmentBlocked,
} = require('../src/services/paymentEligibility');

const order = {
  orderDate: '2026-09-19T21:38:00+08:00',
  orderNumber: 'W123',
  orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W123/synthetic',
  emailOrderStatus: 'confirmed',
  emailPaymentStatus: 'unknown',
};
const task = { id: 1, orderId: 2, version: 0, processingStatus: 'pending', order };
const now = new Date('2026-09-19T14:00:00Z');

test('付款截止只取来源下单时间加 30 分钟', () => {
  expect(getPaymentDeadline(order).toISOString()).toBe('2026-09-19T14:08:00.000Z');
  expect(getPaymentDeadline({ orderDate: '2026-12-31T23:50:00+08:00' }).toISOString()).toBe(
    '2026-12-31T16:20:00.000Z'
  );
});

test.each([null, '', '2026-09-19', 'bad', '2026-09-19T20:00:00', new Date(NaN)])(
  '无精确来源时间不生成截止时间 %s',
  value => expect(getPaymentDeadline({ orderDate: value })).toBeNull()
);

test('邮件未知及待核实只提示，不阻止分配', () => {
  const flagged = { ...order, emailOrderStatus: 'unknown', emailStatusNeedsReview: true };
  expect(isAssignmentBlocked(flagged, true, now)).toBe(false);
  const result = assessAssignment({ ...task, order: flagged }, 0, now);
  expect(result.eligible).toBe(true);
  expect(result.warnings).toEqual(['邮件订单状态待确认', '邮件状态需要人工核对']);
});

test('邮件付款证据阻止自动及手工分配', () => {
  const paid = { ...order, emailPaymentStatus: 'paid' };
  expect(isAssignmentBlocked(paid, false, now)).toBe(true);
  expect(isAssignmentBlocked(paid, true, now)).toBe(true);
  expect(assessAssignment({ ...task, order: paid }, 0, now)).toMatchObject({
    eligible: false,
    code: 'PAYMENT_NOT_ELIGIBLE',
  });
});

test('历史限制在任务完成并重开后仍阻止重新分配', () => {
  const held = {
    ...order,
    paymentAssignmentHoldReason: 'legacy_payment_restriction',
    paymentAssignmentHoldEvidence: { source: 'official_archive' },
  };
  expect(isAssignmentBlocked(held, true, now)).toBe(true);
  expect(assessAssignment({ ...task, processingStatus: 'pending', order: held }, 0, now)).toMatchObject(
    { eligible: false, code: 'PAYMENT_NOT_ELIGIBLE' }
  );
});

test('付款过期只阻止自动分配，手工交接仍可继续', () => {
  const expiredNow = new Date('2026-09-20T00:00:00Z');
  expect(isAssignmentBlocked(order, false, expiredNow)).toBe(true);
  expect(isAssignmentBlocked(order, true, expiredNow)).toBe(false);
  expect(assessAssignment(task, 0, expiredNow)).toMatchObject({ eligible: true, expired: true });
});

test('链接、版本和已完成任务仍校验并给出解决方法', () => {
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
