const { Op } = require('sequelize');
const { buildOrderDateCondition } = require('../src/utils/orderDateFilter');
test('起止覆盖北京时间全天、支持旧参数及单边范围', () => {
  const range = buildOrderDateCondition({ dateFrom: '2026-09-13', dateTo: '2026-09-13' });
  expect(range[Op.gte].toISOString()).toBe('2026-09-12T16:00:00.000Z');
  expect(range[Op.lte].toISOString()).toBe('2026-09-13T15:59:59.999Z');
  expect(buildOrderDateCondition({ 'date_from': '2026-09-13', 'date_to': '2026-09-13' })).toEqual(
    range
  );
  expect(Reflect.ownKeys(buildOrderDateCondition({ dateFrom: '2026-09-13' }))).toEqual([Op.gte]);
  expect(buildOrderDateCondition({})).toBeNull();
});
test.each([
  { dateFrom: '2026-02-30' },
  { dateFrom: 'bad' },
  { dateFrom: ['2026-09-13'] },
  { dateTo: 42 },
  { dateFrom: '2026-09-14', dateTo: '2026-09-13' },
])('拒绝非法日期或反向范围 %j', query => {
  expect(() => buildOrderDateCondition(query)).toThrow();
});
