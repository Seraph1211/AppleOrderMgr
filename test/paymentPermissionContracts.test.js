const { PERMISSIONS } = require('../src/constants/business');
const {
  validatePermissionSet,
  resolveAvailableHome,
} = require('../src/services/permissionService');
const { assignOrderPayer } = require('../src/services/payerService');

describe('付款权限与入口契约', () => {
  test('拒绝未知权限、管理员保留权限和不完整依赖', () => {
    expect(() => validatePermissionSet(['unknown.permission'])).toThrow('包含未知权限码');
    expect(() => validatePermissionSet([PERMISSIONS.USERS_READ])).toThrow(
      '管理员保留权限不能授予普通用户'
    );
    expect(() => validatePermissionSet([PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN])).toThrow(
      '权限依赖不完整'
    );
  });

  test('本人付款任务首页优先且空权限没有业务首页', () => {
    expect(
      resolveAvailableHome([PERMISSIONS.ORDERS_READ, PERMISSIONS.PAYMENT_TASKS_READ_OWN])
    ).toBe('/payment-tasks');
    expect(resolveAvailableHome([])).toBeNull();
  });

  test('付款人仅接受可清空且不超过 100 字的自由文本姓名', async () => {
    await expect(
      assignOrderPayer(1, { expectedVersion: 0, idempotencyKey: 'payer-0' }, 1)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      assignOrderPayer(1, { payerName: 123, expectedVersion: 0, idempotencyKey: 'payer-1' }, 1)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      assignOrderPayer(
        1,
        { payerName: '付'.repeat(101), expectedVersion: 0, idempotencyKey: 'payer-2' },
        1
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('权限目录不再暴露付款人主数据权限', () => {
    expect(Object.values(PERMISSIONS).some(code => code.startsWith('payers.'))).toBe(false);
  });
});
