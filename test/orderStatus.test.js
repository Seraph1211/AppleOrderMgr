const { Op } = require('sequelize');
const { ORDER_STATUSES, normalizeOrderStatus } = require('../src/constants/business');
const { buildOrderStatusCondition } = require('../src/utils/orderStatusFilter');
const { buildOfficialStatusCondition } = require('../src/services/paymentStatusFilter');
const {
  isPaymentBlocked,
  paymentForStatus,
  pickupForStatus,
} = require('../src/services/crawler/officialOrderData');

test('官网状态保留 pending 与 unknown，移除订单 completed', () => {
  expect(ORDER_STATUSES).toHaveLength(12);
  expect(ORDER_STATUSES).toEqual(expect.arrayContaining(['pending', 'unknown', 'picked_up']));
  expect(ORDER_STATUSES).not.toContain('completed');
  for (const status of ORDER_STATUSES) expect(normalizeOrderStatus(status)).toBe(status);
});

test.each(['completed', 'invalid', '', null, undefined, 'constructor'])(
  '无效状态 %s 归 unknown，不推断付款或取货',
  status => {
    expect(normalizeOrderStatus(status)).toBe('unknown');
    expect(paymentForStatus(status)).toBeNull();
    expect(pickupForStatus(status)).toBe('unknown');
    expect(isPaymentBlocked({ status })).toBe(true);
  }
);

test('unknown 筛选覆盖非法存量值，两付款页共用同一查询', () => {
  const expected = {
    [Op.or]: [
      { [Op.in]: ['pending', 'unknown'] },
      { [Op.notIn]: ORDER_STATUSES },
      { [Op.is]: null },
    ],
  };
  expect(buildOrderStatusCondition(['pending', 'unknown'])).toEqual(expected);
  expect(buildOfficialStatusCondition({ officialOrderStatuses: ['pending', 'unknown'] })).toEqual(
    expected
  );
  expect(buildOrderStatusCondition([])).toBeNull();
  expect(isPaymentBlocked({ status: 'pending' })).toBe(false);
});
