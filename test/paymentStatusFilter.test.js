const { Op } = require('sequelize');
const { buildOfficialStatusCondition } = require('../src/services/paymentStatusFilter');

test('多状态按 OR 去重，兼容旧单值，空选不限制', () => {
  expect(
    buildOfficialStatusCondition({
      officialOrderStatuses: '["payment_due","processing","payment_due"]',
    })
  ).toEqual({ [Op.in]: ['payment_due', 'processing'] });
  expect(buildOfficialStatusCondition({ officialOrderStatus: 'payment_due' })).toEqual({
    [Op.in]: ['payment_due'],
  });
  expect(buildOfficialStatusCondition({})).toBeNull();
  expect(
    buildOfficialStatusCondition({ officialOrderStatuses: [], officialOrderStatus: 'processing' })
  ).toBeNull();
});
test.each([
  'bad',
  'null',
  '{}',
  '"payment_due"',
  '[1]',
  '["bad"]',
  null,
  42,
  Array(14).fill('payment_due'),
])('拒绝非法多选 %j', officialOrderStatuses => {
  expect(() => buildOfficialStatusCondition({ officialOrderStatuses })).toThrow();
});
