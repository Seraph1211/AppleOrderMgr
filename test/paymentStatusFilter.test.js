const { Op } = require('sequelize');
const {
  EMAIL_ORDER_STATUSES,
  buildEmailStatusCondition,
} = require('../src/services/paymentStatusFilter');

test('邮件状态多选按 OR 去重，兼容单值，空选不限制', () => {
  expect(
    buildEmailStatusCondition({
      emailOrderStatuses: '["confirmed","processing","confirmed"]',
    })
  ).toEqual({ [Op.in]: ['confirmed', 'processing'] });
  expect(buildEmailStatusCondition({ emailOrderStatus: 'ready_for_pickup' })).toEqual({
    [Op.in]: ['ready_for_pickup'],
  });
  expect(buildEmailStatusCondition({ emailOrderStatus: 'picked_up' })).toEqual({
    [Op.in]: ['picked_up'],
  });
  expect(buildEmailStatusCondition({})).toBeNull();
});
test.each([
  'bad',
  'null',
  '{}',
  '"confirmed"',
  '[1]',
  '["bad"]',
  null,
  42,
  Array(EMAIL_ORDER_STATUSES.length + 1).fill('confirmed'),
])('拒绝非法邮件状态多选 %j', emailOrderStatuses => {
  expect(() => buildEmailStatusCondition({ emailOrderStatuses })).toThrow();
});

test.each([{ officialOrderStatus: 'payment_due' }, { officialOrderStatuses: '[]' }])(
  '拒绝退休的官网状态参数 %j',
  query => expect(() => buildEmailStatusCondition(query)).toThrow('官网订单状态筛选参数已退休')
);

test.each(['partially_cancelled', 'expired', 'cancelled'])('接受 Apple 邮件终态 %s', status => {
  expect(buildEmailStatusCondition({ emailOrderStatus: status })).toEqual({ [Op.in]: [status] });
});
