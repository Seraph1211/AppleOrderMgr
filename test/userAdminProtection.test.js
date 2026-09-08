const mockFindByPk = jest.fn();
const mockCount = jest.fn();
const mockQuery = jest.fn();
const mockTransactionObject = { LOCK: { UPDATE: 'UPDATE' } };

jest.mock('../src/models', () => ({
  User: {
    findByPk: mockFindByPk,
    count: mockCount,
  },
  sequelize: {
    query: mockQuery,
    transaction: jest.fn(callback => callback(mockTransactionObject)),
  },
}));
jest.mock('../src/services/authService', () => ({}));
jest.mock('../src/services/permissionService', () => ({}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn() }));

const userController = require('../src/controllers/userController');

describe('最后一个可用管理员保护', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('拒绝降级最后一个正常管理员', async () => {
    mockFindByPk.mockResolvedValue({
      id: 1,
      role: 'admin',
      status: 'active',
      save: jest.fn(),
    });
    mockCount.mockResolvedValue(1);
    const req = {
      params: { id: '1' },
      body: { role: 'operator' },
      user: { username: 'admin' },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await expect(userController.updateUser(req, res)).rejects.toThrow(
      '不能降级或锁定最后一个可用管理员账号'
    );
  });
});
