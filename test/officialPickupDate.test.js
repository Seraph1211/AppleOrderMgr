/* eslint-disable no-magic-numbers -- 日期合法性、跨年与逐件边界。 */
const {
  resolvePickupDate,
  deriveOfficialPickupDate,
} = require('../src/services/officialPickupDate');
const observed = '2026-10-07T12:00:00Z';
test.each([
  ['已取货 9月 22', '2026年9月18日', observed, '2026-09-22'],
  ['已取货 2026年9月22日', '2026年9月18日', observed, '2026-09-22'],
  ['已取货 1月 2', '2025年12月30日', '2026-01-03T00:00:00Z', '2026-01-02'],
  ['已取货 9月 22', '2025年9月18日', observed, null],
  ['已取货 2月 30', '2026年2月1日', observed, null],
  ['已取货 9月 17', '2026年9月18日', observed, null],
  ['已取货 10月 8', '2026年9月18日', observed, null],
  ['准备取货 9月 22', '2026年9月18日', observed, null],
  ['已取货', '2026年9月18日', observed, null],
  ['已取货 9月 22', null, observed, null],
  ['已取货 2月 29', '2024年2月1日', '2024-03-01T00:00:00Z', '2024-02-29'],
])('解析 %s / %s', (raw, placed, when, expected) => {
  expect(resolvePickupDate(raw, placed, when)).toBe(expected);
});
const result = () => ({
  orderPlacedDateText: '2026年9月18日',
  products: [1, 2].map(quantity => ({
    quantity,
    rawStatus: 'PICKED_UP',
    pickupDateText: '已取货 9月 22',
  })),
});
test('两项取货日期一致才输出，不采信伪造整单日期', () => {
  const data = { ...result(), actualPickupDate: '2026-01-01' };
  expect(deriveOfficialPickupDate(data, observed)).toEqual({ date: '2026-09-22', reason: null });
  data.products[1].pickupDateText = '已取货 9月 23';
  expect(deriveOfficialPickupDate(data, observed).reason).toBe('MULTIPLE_PICKUP_DATES');
});
test('部分取货、缺失、全部零数量均不填日期', () => {
  const data = result();
  data.products[1].rawStatus = 'READY_FOR_PICKUP';
  expect(deriveOfficialPickupDate(data, observed).date).toBeNull();
  data.products[1].quantity = 0;
  expect(deriveOfficialPickupDate(data, observed).date).toBe('2026-09-22');
  data.products[0].pickupDateText = null;
  expect(deriveOfficialPickupDate(data, observed).date).toBeNull();
  data.products[0].quantity = 0;
  expect(deriveOfficialPickupDate(data, observed).date).toBeNull();
});
