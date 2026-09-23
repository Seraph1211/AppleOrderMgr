jest.mock('../src/models', () => ({ Order: { findAll: jest.fn() }, sequelize: {} }));
jest.mock('../src/utils/logger', () => ({ error: jest.fn() }));
const { Op } = require('sequelize');
const { Order } = require('../src/models');
const { getDailyTrend } = require('../src/services/dashboardService');

test('趋势使用北京时间日界，单日筛选保留凌晨订单并填充正确日期', async () => {
  Order.findAll.mockResolvedValue([{ date: '2026-09-09', count: '2' }]);
  const rows = await getDailyTrend({ startDate: '2026-09-09', endDate: '2026-09-09' });
  const options = Order.findAll.mock.calls[0][0];
  expect(options.attributes[0][0].val).toContain("DATE(order_date AT TIME ZONE 'Asia/Shanghai')");
  expect(options.where.orderDate[Op.gte].toISOString()).toBe('2026-09-08T16:00:00.000Z');
  expect(options.where.orderDate[Op.lte].toISOString()).toBe('2026-09-09T15:59:59.999Z');
  expect(rows).toEqual([{ date: '2026-09-09', count: 2 }]);
});
