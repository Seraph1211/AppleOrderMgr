const { Op } = require('sequelize');
const { buildEmailStatusCondition } = require('../src/services/paymentStatusFilter');

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
  Array(6).fill('confirmed'),
])('拒绝非法邮件状态多选 %j', emailOrderStatuses => {
  expect(() => buildEmailStatusCondition({ emailOrderStatuses })).toThrow();
});

test.each([{ officialOrderStatus: 'payment_due' }, { officialOrderStatuses: '[]' }])(
  '拒绝退休的官网状态参数 %j',
  query => expect(() => buildEmailStatusCondition(query)).toThrow('官网订单状态筛选参数已退休')
);
