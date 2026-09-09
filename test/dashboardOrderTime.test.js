jest.mock('../src/models', () => ({
  Order: {},
  AppleId: {},
  Recipient: {},
  sequelize: { query: jest.fn(), QueryTypes: { SELECT: 'SELECT' } },
}));
jest.mock('../src/utils/logger', () => ({ error: jest.fn() }));
const { sequelize } = require('../src/models');
const { getDailyTrend } = require('../src/services/dashboardService');

test('趋势使用北京时间日界，单日筛选保留凌晨订单并填充正确日期', async () => {
  try {
    sequelize.query.mockResolvedValue([{ date: '2026-09-09', count: '2' }]);
    const rows = await getDailyTrend({ startDate: '2026-09-09', endDate: '2026-09-09' });
    const [sql, options] = sequelize.query.mock.calls[0];
    expect(sql).toContain("DATE(order_date AT TIME ZONE 'Asia/Shanghai')");
    expect(options.replacements.startDate.toISOString()).toBe('2026-09-08T16:00:00.000Z');
    expect(options.replacements.endDate.toISOString()).toBe('2026-09-09T15:59:59.999Z');
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
  } catch (error) {
    error.message = `统计时区回归失败：${error.message}`;
    throw error;
  }
});
