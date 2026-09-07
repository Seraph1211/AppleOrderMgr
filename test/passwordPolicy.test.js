const mockChangePassword = jest.fn();
const mockLogin = jest.fn();
const mockFindOne = jest.fn();
const mockCreate = jest.fn();

jest.mock('../src/services/authService', () => ({
  changePassword: mockChangePassword,
  login: mockLogin,
}));
jest.mock('../src/models', () => ({
  User: {
    findOne: mockFindOne,
    create: mockCreate,
  },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

const authController = require('../src/controllers/authController');
const userController = require('../src/controllers/userController');

function createResponse() {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

describe('密码长度接口契约', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('改密接口拒绝 7 位新密码', async () => {
    const request = {
      body: {
        oldPassword: 'old-password',
        newPassword: '1234567',
        confirmPassword: '1234567',
      },
      user: { id: 1 },
    };
    const response = createResponse();

    await authController.changePassword(request, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: '新密码长度不能少于 8 位',
    });
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  test('登录接口拒绝 7 位密码', async () => {
    const request = {
      body: { username: 'operator', password: '1234567' },
      ip: '127.0.0.1',
    };
    const response = createResponse();

    await authController.login(request, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: '密码长度不能少于 8 位',
    });
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test('改密接口接受 8 位新密码', async () => {
    mockChangePassword.mockResolvedValue();
    const request = {
      body: {
        oldPassword: 'old-password',
        newPassword: '12345678',
        confirmPassword: '12345678',
      },
      user: { id: 1 },
    };
    const response = createResponse();

    await authController.changePassword(request, response);

    expect(mockChangePassword).toHaveBeenCalledWith(1, 'old-password', '12345678');
    expect(response.status).toHaveBeenCalledWith(200);
  });

  test('创建用户接口拒绝 7 位密码', async () => {
    const request = {
      body: { username: 'operator', password: '1234567', role: 'operator' },
      user: { username: 'admin' },
    };
    const response = createResponse();

    await userController.createUser(request, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      message: '密码长度不能少于 8 位',
    });
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  test('创建用户接口接受 8 位密码', async () => {
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({
      id: 2,
      username: 'operator',
      role: 'operator',
      status: 'active',
      createdAt: new Date('2026-09-06T00:00:00.000Z'),
    });
    const request = {
      body: { username: 'operator', password: '12345678', role: 'operator' },
      user: { username: 'admin' },
    };
    const response = createResponse();

    await userController.createUser(request, response);

    expect(mockCreate).toHaveBeenCalledWith({
      username: 'operator',
      password: '12345678',
      role: 'operator',
      status: 'active',
      forcePasswordChange: true,
    });
    expect(response.status).toHaveBeenCalledWith(201);
  });
});
