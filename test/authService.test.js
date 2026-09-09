const mockGenerateToken = jest.fn(() => 'signed-token');
const mockFindOne = jest.fn();
const mockFindByPk = jest.fn();

jest.mock('../src/models', () => ({
  User: {
    findOne: mockFindOne,
    findByPk: mockFindByPk,
  },
  sequelize: { transaction: jest.fn(callback => callback({ LOCK: { UPDATE: 'UPDATE' } })) },
  UserPermission: {
    findAll: jest.fn(() => Promise.resolve([])),
  },
}));
jest.mock('../src/utils/jwtUtils', () => ({
  generateToken: mockGenerateToken,
  decodeToken: jest.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  verifyToken: jest.fn(),
  generateConfirmationToken: jest.fn(() => 'confirmation'),
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const authService = require('../src/services/authService');

describe('账户锁定恢复', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('临时锁定到期后应先解锁再签发 token', async () => {
    const user = {
      id: 1,
      username: 'operator',
      role: 'operator',
      status: 'locked',
      lockedUntil: new Date(Date.now() - 60_000),
      failedLoginAttempts: 5,
      forcePasswordChange: false,
      unlockAccount: jest.fn(() => {
        user.status = 'active';
        user.lockedUntil = null;
        user.failedLoginAttempts = 0;
        return Promise.resolve();
      }),
      isLocked: jest.fn(() => user.status === 'locked'),
      comparePassword: jest.fn(() => Promise.resolve(true)),
      resetFailedAttempts: jest.fn(),
      save: jest.fn(),
    };
    mockFindOne.mockResolvedValue(user);

    const result = await authService.login('operator', 'correct-password', '127.0.0.1');

    expect(user.status).toBe('active');
    expect(user.lockedUntil).toBeNull();
    expect(user.comparePassword).toHaveBeenCalledWith('correct-password');
    expect(mockGenerateToken).toHaveBeenCalledTimes(1);
    expect(result.token).toBe('signed-token');
  });
});

describe('密码长度策略', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('修改密码时拒绝 7 位新密码', async () => {
    await expect(authService.changePassword(1, 'old-password', '1234567')).rejects.toThrow(
      '新密码长度不能少于 8 位'
    );
    expect(mockFindByPk).not.toHaveBeenCalled();
  });

  test('修改密码时接受 8 位新密码', async () => {
    const user = {
      id: 1,
      username: 'operator',
      password: 'old-hash',
      forcePasswordChange: true,
      comparePassword: jest.fn(() => Promise.resolve(true)),
      save: jest.fn(() => Promise.resolve()),
    };
    mockFindByPk.mockResolvedValue(user);

    await authService.changePassword(1, 'old-password', '12345678');

    expect(user.password).toBe('12345678');
    expect(user.forcePasswordChange).toBe(false);
    expect(user.save).toHaveBeenCalledTimes(1);
  });
});
