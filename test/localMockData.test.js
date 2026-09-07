/* eslint-disable no-magic-numbers -- 断言固定的本地 Mock 数据规模和日期 */
jest.mock('../src/models', () => ({
  sequelize: {},
  AppleId: {},
  Recipient: {},
  Order: {},
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

  test('生成确定性的关联数据和可用取机人口径', () => {
    const result = buildMockDefinitions(new Date('2026-09-07T08:00:00.000Z'));

    expect(result.appleIds).toHaveLength(8);
    expect(result.recipients).toHaveLength(20);
    expect(result.orders).toHaveLength(48);
    expect(
      result.recipients.filter(recipient => ['使用中', '未使用'].includes(recipient.status))
    ).toHaveLength(16);
    expect(new Set(result.orders.map(order => order.orderNumber))).toHaveProperty('size', 48);
    expect(result.orders.every(order => order.autoRefreshEnabled === false)).toBe(true);
    expect(result.orders[0].orderDate.toISOString()).toBe('2026-09-07T12:00:00.000Z');
  });
});
