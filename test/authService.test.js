const mockGenerateToken = jest.fn(() => 'signed-token');
const mockFindOne = jest.fn();

jest.mock('../src/models', () => ({
  User: {
    findOne: mockFindOne,
  },
}));
jest.mock('../src/utils/jwtUtils', () => ({
  generateToken: mockGenerateToken,
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

    expect(user.unlockAccount).toHaveBeenCalledTimes(1);
    expect(user.comparePassword).toHaveBeenCalledWith('correct-password');
    expect(mockGenerateToken).toHaveBeenCalledTimes(1);
    expect(result.token).toBe('signed-token');
  });
});
