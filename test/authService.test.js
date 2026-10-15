const mockGenerateToken = jest.fn(() => 'signed-token');
const mockFindOne = jest.fn();
const mockFindByPk = jest.fn();
const ACTIVE_SESSION_COUNT = 32;
const ACTIVE_SESSION_TTL_MS = 3600000;
const SESSION_CREATED_STEP_MS = 1000;

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
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const authService = require('../src/services/authService');

describe('所有角色均不限制登录设备数量', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each(['admin', 'operator', 'pickupStaff', 'readOnly'])(
    '%s 新登录保留全部既有有效会话，仅剔除过期项',
    async role => {
      const activeSessions = Array.from({ length: ACTIVE_SESSION_COUNT }, (_, index) => ({
        id: `session-${index}`,
        expiresAt: new Date(Date.now() + ACTIVE_SESSION_TTL_MS).toISOString(),
        createdAt: new Date(Date.now() - (index + 1) * SESSION_CREATED_STEP_MS).toISOString(),
      }));
      const user = {
        id: 1,
        username: 'multi_device_user',
        role,
        status: 'active',
        activeSessions: [
          ...activeSessions,
          { id: 'expired-session', expiresAt: new Date(0).toISOString() },
        ],
        isLocked: jest.fn(() => false),
        comparePassword: jest.fn(() => Promise.resolve(true)),
        save: jest.fn(() => Promise.resolve()),
      };
      mockFindOne.mockResolvedValue(user);

      const result = await authService.login(user.username, 'correct-password');

      expect(result.user.role).toBe(role);
      expect(user.activeSessions).toHaveLength(ACTIVE_SESSION_COUNT + 1);
      expect(user.activeSessions).toEqual(expect.arrayContaining(activeSessions));
      expect(user.activeSessions.some(session => session.id === 'expired-session')).toBe(false);
      expect(new Set(user.activeSessions.map(session => session.id)).size).toBe(
        ACTIVE_SESSION_COUNT + 1
      );
      expect(user.save).toHaveBeenCalledTimes(1);
    }
  );
});

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
