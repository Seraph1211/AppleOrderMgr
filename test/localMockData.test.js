/* eslint-disable no-magic-numbers -- 断言固定的本地 Mock 数据规模和日期 */
jest.mock('../src/models', () => ({
  sequelize: {},
  AppleId: {},
  Recipient: {},
  Order: {},
  User: {},
  UserPermission: {},
  UserPermissionEvent: {},
  PaymentTask: {},
  PaymentTaskEvent: {},
  PaymentStaffSetting: {},
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

const {
  assertLocalMockEnvironment,
  buildMockDefinitions,
} = require('../scripts/generateLocalMockData');

describe('本地 Mock 数据脚本', () => {
  test('拒绝生产环境', () => {
    expect(() =>
      assertLocalMockEnvironment({
        NODE_ENV: 'production',
        ALLOW_LOCAL_MOCK_DATA: 'true',
        DB_HOST: 'postgres',
      })
    ).toThrow('仅允许在 NODE_ENV=development');
  });

  test('拒绝未显式确认的写入', () => {
    expect(() =>
      assertLocalMockEnvironment({
        NODE_ENV: 'development',
        DB_HOST: 'postgres',
      })
    ).toThrow('必须显式设置 ALLOW_LOCAL_MOCK_DATA=true');
  });

  test('拒绝远程数据库主机', () => {
    expect(() =>
      assertLocalMockEnvironment({
        NODE_ENV: 'development',
        ALLOW_LOCAL_MOCK_DATA: 'true',
        DB_HOST: 'production.example.com',
      })
    ).toThrow('不属于允许的本地目标');
  });

  test('拒绝未配置工作人员临时密码', () => {
    expect(() =>
      assertLocalMockEnvironment({
        NODE_ENV: 'development',
        ALLOW_LOCAL_MOCK_DATA: 'true',
        DB_HOST: 'postgres',
      })
    ).toThrow('LOCAL_MOCK_USER_PASSWORD 必须显式配置');
  });

  test('生成确定性的基础资料和付款任务体验数据', () => {
    const result = buildMockDefinitions(new Date('2026-09-07T08:00:00.000Z'));

    expect(result.appleIds).toHaveLength(8);
    expect(result.recipients).toHaveLength(20);
    expect(result.orders).toHaveLength(48);
    expect(result.staff).toHaveLength(3);
    expect(result.paymentTasks).toHaveLength(30);
    expect(
      result.recipients.filter(recipient => ['使用中', '未使用'].includes(recipient.status))
    ).toHaveLength(16);
    expect(new Set(result.orders.map(order => order.orderNumber))).toHaveProperty('size', 48);
    expect(result.orders.every(order => order.autoRefreshEnabled === false)).toBe(true);
    expect(result.orders[0].orderDate.toISOString()).toBe('2026-09-07T12:00:00.000Z');
    expect(result.orders[0].officialOrderCreatedAt.toISOString()).toBe('2026-09-07T07:25:00.000Z');
    expect(result.paymentTasks[0].deadlineSource).toBe('official');
    expect(
      result.paymentTasks[0].deadlineAt.getTime() -
        result.orders[0].officialOrderCreatedAt.getTime()
    ).toBe(30 * 60 * 1000);
    expect(result.orders.slice(0, 30).every(order => order.paymentStatus !== '已支付')).toBe(true);
    expect(result.paymentTasks.filter(task => task.assigneeIndex === null)).toHaveLength(6);
    expect(result.paymentTasks.filter(task => task.payerName)).toHaveLength(22);
    expect(result.paymentTasks[1].payerName).toBe('测试付款人 02');
    expect(new Set(result.paymentTasks.map(task => task.processingStatus))).toEqual(
      new Set(['pending', 'processing', 'completed', 'exception'])
    );
    expect(result.staff[0].permissions).toHaveLength(5);
    expect(result.staff[2].permissions).toEqual(['payment_tasks.read_own']);
  });
});
