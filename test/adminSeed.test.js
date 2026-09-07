const adminSeed = require('../seeds/20260719000001-create-default-admin');

describe('管理员种子密码长度策略', () => {
  const originalPassword = process.env.ADMIN_INITIAL_PASSWORD;

  afterEach(() => {
    if (originalPassword === undefined) {
      delete process.env.ADMIN_INITIAL_PASSWORD;
    } else {
      process.env.ADMIN_INITIAL_PASSWORD = originalPassword;
    }
  });

  test('拒绝 7 位初始密码', async () => {
    process.env.ADMIN_INITIAL_PASSWORD = '1234567';
    const queryInterface = {
      sequelize: { query: jest.fn() },
      bulkInsert: jest.fn(),
    };

    await expect(adminSeed.up(queryInterface)).rejects.toThrow(
      'ADMIN_INITIAL_PASSWORD 必须显式配置且至少 8 位'
    );
    expect(queryInterface.sequelize.query).not.toHaveBeenCalled();
  });

  test('接受 8 位初始密码', async () => {
    process.env.ADMIN_INITIAL_PASSWORD = '12345678';
    const queryInterface = {
      sequelize: { query: jest.fn(() => Promise.resolve([[{ id: 1 }]])) },
      bulkInsert: jest.fn(),
    };

    await expect(adminSeed.up(queryInterface)).resolves.toBeUndefined();
    expect(queryInterface.sequelize.query).toHaveBeenCalledTimes(1);
    expect(queryInterface.bulkInsert).not.toHaveBeenCalled();
  });
});
