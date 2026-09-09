jest.mock('../src/models', () => ({ User: {} }));
jest.mock('../src/services/permissionService', () => ({ getEffectivePermissions: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { requirePermission, requireRole } = require('../src/middleware/authMiddleware');
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

describe('逐用户权限矩阵', () => {
  test('管理员拥有全部已定义权限', () => {
    expect(ROLE_PERMISSIONS.admin).toEqual(expect.arrayContaining(Object.values(PERMISSIONS)));
  });

  test('普通用户角色不再隐式授权', () => {
    expect(ROLE_PERMISSIONS.operator).toEqual([]);
    expect(ROLE_PERMISSIONS.readOnly).toEqual([]);
  });

  test.each([
    PERMISSIONS.DASHBOARD_READ,
    PERMISSIONS.STATS_READ,
    PERMISSIONS.ORDERS_READ,
    PERMISSIONS.APPLE_IDS_READ,
    PERMISSIONS.RECIPIENTS_READ,
    PERMISSIONS.CHANNELS_READ,
    PERMISSIONS.EMAIL_READ,
  ])('只有本人付款任务权限时拒绝其他业务权限 %s', requiredPermission => {
    const req = {
      user: {
        id: 3,
        role: 'operator',
        permissions: [
          PERMISSIONS.PAYMENT_TASKS_READ_OWN,
          PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN,
          PERMISSIONS.PAYMENT_TASKS_PAYER_EDIT_OWN,
          PERMISSIONS.PAYMENT_TASKS_LINK_READ_OWN,
          PERMISSIONS.PAYMENT_TASKS_REFRESH_OWN,
        ],
      },
      path: '/business-resource',
    };
    const res = createResponse();
    const next = jest.fn();

    requirePermission(requiredPermission)(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(next).not.toHaveBeenCalled();
  });

  test('明确拥有所需权限时继续请求', () => {
    const req = {
      user: { id: 2, role: 'operator', permissions: [PERMISSIONS.ORDERS_EXPORT] },
      path: '/orders/export',
    };
    const res = createResponse();
    const next = jest.fn();

    requirePermission(PERMISSIONS.ORDERS_EXPORT)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.body).toBeNull();
  });

  test.each(['operator', 'readOnly'])('非管理员角色不能进入管理员保留端点', role => {
    const req = { user: { id: 3, role, permissions: [] }, path: '/email-processing' };
    const res = createResponse();
    const next = jest.fn();

    requireRole(['admin'])(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('存量强制改密标记不再阻止已授权业务', () => {
    const req = {
      user: { id: 4, forcePasswordChange: true, permissions: [PERMISSIONS.ORDERS_READ] },
      path: '/orders',
    };
    const res = createResponse();
    const next = jest.fn();
    requirePermission(PERMISSIONS.ORDERS_READ)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
