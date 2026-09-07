jest.mock('../src/models', () => ({ User: {} }));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  checkPasswordChangeRequired,
  requirePermission,
  requireRole,
} = require('../src/middleware/authMiddleware');
const { PERMISSIONS, ROLE_PERMISSIONS } = require('../src/constants/business');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('最小权限矩阵', () => {
  test('管理员拥有全部已定义权限', () => {
    expect(ROLE_PERMISSIONS.admin).toEqual(expect.arrayContaining(Object.values(PERMISSIONS)));
  });

  test('业务操作员可写入和导出但不可删除或查看秘密', () => {
    expect(ROLE_PERMISSIONS.operator).toEqual(
      expect.arrayContaining([PERMISSIONS.READ, PERMISSIONS.WRITE, PERMISSIONS.EXPORT])
    );
    expect(ROLE_PERMISSIONS.operator).not.toContain(PERMISSIONS.DELETE);
    expect(ROLE_PERMISSIONS.operator).not.toContain(PERMISSIONS.VIEW_SECRETS);
  });

  test('只读用户的写请求返回 403', () => {
    const req = { user: { id: 3, role: 'readOnly' }, path: '/orders/1' };
    const res = createResponse();
    const next = jest.fn();

    requirePermission(PERMISSIONS.WRITE)(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(next).not.toHaveBeenCalled();
  });

  test('只读用户不能提交订单刷新任务', () => {
    const req = { user: { id: 3, role: 'readOnly' }, path: '/orders/1/refresh' };
    const res = createResponse();
    const next = jest.fn();

    requirePermission(PERMISSIONS.REFRESH)(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(next).not.toHaveBeenCalled();
  });

  test.each(['operator', 'readOnly'])('非管理员角色不能访问邮件处理页面和 API', role => {
    const req = { user: { id: 3, role }, path: '/email-processing' };
    const res = createResponse();
    const next = jest.fn();

    requireRole(['admin'])(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('符合权限时继续请求', () => {
    const req = { user: { id: 2, role: 'operator' }, path: '/orders/export' };
    const res = createResponse();
    const next = jest.fn();

    requirePermission(PERMISSIONS.EXPORT)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.body).toBeNull();
  });

  test('被标记强制改密的用户不得访问业务 API', () => {
    const req = {
      user: { id: 4, username: 'new-user', role: 'operator', forcePasswordChange: true },
      path: '/orders',
    };
    const res = createResponse();
    const next = jest.fn();

    checkPasswordChangeRequired(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.forcePasswordChange).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  test('已完成改密的用户可继续访问业务 API', () => {
    const req = {
      user: { id: 4, username: 'user', role: 'operator', forcePasswordChange: false },
      path: '/orders',
    };
    const res = createResponse();
    const next = jest.fn();

    checkPasswordChangeRequired(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.body).toBeNull();
  });
});
