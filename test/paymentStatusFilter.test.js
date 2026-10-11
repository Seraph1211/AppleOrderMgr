const { Op } = require('sequelize');
const {
  EMAIL_ORDER_STATUSES,
  buildEmailStatusCondition,
  buildPaymentOfficialStatusCondition,
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
  expect(buildEmailStatusCondition({ emailOrderStatuses: [] })).toBeNull();
  expect(buildEmailStatusCondition({ emailOrderStatuses: '[]' })).toBeNull();
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

test.each(['partially_cancelled', 'expired', 'cancelled'])('接受 Apple 邮件终态 %s', status => {
  expect(buildEmailStatusCondition({ emailOrderStatus: status })).toEqual({ [Op.in]: [status] });
});

const { Sequelize } = require('sequelize');
const sequelize = { escape: value => "'" + String(value).replaceAll("'", "''") + "'" };
test('官网状态匹配共用Orders同义项，复合任一项和未观测', () => {
  const condition = buildPaymentOfficialStatusCondition(
    { officialOrderStatuses: '["PICKUP_READY","__not_observed__"]' },
    sequelize,
    Sequelize
  );
  expect(condition.val).toContain('"order"."official_raw_status"');
  expect(condition.val).toContain("'READY_FOR_PICKUP'");
  expect(condition.val).toContain("'PICKUP_READY'");
  expect(condition.val).toContain('regexp_split_to_array');
  expect(condition.val).toContain("= '' OR");
});
test.each([undefined, null, '', '[]', []])('官网空选%j不限制', officialOrderStatuses => {
  expect(
    buildPaymentOfficialStatusCondition({ officialOrderStatuses }, sequelize, Sequelize)
  ).toBeNull();
});
test.each([
  '[',
  '[1]',
  {},
  '["A | B"]',
  JSON.stringify(Array(101).fill('SHIPPED')),
  JSON.stringify(['A'.repeat(101)]),
])('官网非法选择%j拒绝', officialOrderStatuses => {
  expect(() =>
    buildPaymentOfficialStatusCondition({ officialOrderStatuses }, sequelize, Sequelize)
  ).toThrow();
});
test('未知状态安全转义且不被当成已知枚举强制丢弃', () => {
  const condition = buildPaymentOfficialStatusCondition(
    { officialOrderStatuses: ["NEW'); SELECT 1; --"] },
    sequelize,
    Sequelize
  );
  expect(condition.val).toContain("'NEW''); SELECT 1; --'");
});

test('拒绝退休的旧单值付款阶段参数，避免静默放宽', () => {
  expect(() =>
    buildPaymentOfficialStatusCondition(
      { officialOrderStatus: 'payment_due' },
      sequelize,
      Sequelize
    )
  ).toThrow('officialOrderStatuses');
});
