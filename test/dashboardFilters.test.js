jest.mock('../src/models', () => ({
  sequelize: { escape: value => `'${value.replace(/'/g, "''")}'` },
}));
const { Op } = require('sequelize');
const { parseDashboardFilters, buildDashboardWhere } = require('../src/services/dashboardFilters');

describe('仪表板输入与筛选契约', () => {
  test.each([
    { startDate: '2026-02-30' },
    { startDate: '2026-09-24', endDate: '2026-09-23' },
    { endDate: ['2026-09-23'] },
    { startDate: '2026-09-23T12:00:00' },
    { emailOrderStatuses: '["paid"]' },
    { emailOrderStatuses: 'processing' },
    { recipientTags: 'null' },
    { recipientTags: [1] },
    { recipientTags: [' '] },
    { recipientTags: Array(101).fill('A') },
    { productKeys: '["made-up"]' },
    { status: 'completed' },
    { store: {} },
  ])('应拒绝非法筛选 %j', query => {
    expect(() => parseDashboardFilters(query)).toThrow();
  });
  test('应保留 TAG 原文并去重，权限只能由服务端注入', () => {
    const user = { orderAccess: { mode: 'tags', tags: ['可见'] } };
    const filters = parseDashboardFilters(
      {
        recipientTags: JSON.stringify([" O'Reilly,团队 ", " O'Reilly,团队 "]),
        orderUser: { role: 'admin' },
        status: '可取货',
      },
      user
    );
    expect(filters.recipientTags).toEqual([" O'Reilly,团队 "]);
    expect(filters.orderUser).toBe(user);
    expect(filters.status).toBe('ready_for_pickup');
    expect(buildDashboardWhere(filters).tag[Op.in]).toEqual(['可见']);
  });

  test('应接受邮件推定已取货状态', () => {
    const filters = parseDashboardFilters({
      emailOrderStatuses: '["picked_up"]',
      status: '已取货（邮件推定）',
    });
    expect(filters.emailOrderStatuses).toEqual(['picked_up']);
    expect(filters.status).toBe('picked_up');
    expect(parseDashboardFilters({ status: '已取货' }).status).toBe('picked_up');
  });
});

test.each([
  ['partially_cancelled', '部分取消'],
  ['expired', '已过期'],
  ['cancelled', '已取消'],
])('仪表板支持邮件终态 %s', (status, label) => {
  expect(
    parseDashboardFilters({ status: label, emailOrderStatuses: JSON.stringify([status]) })
  ).toMatchObject({ status, emailOrderStatuses: [status] });
});
