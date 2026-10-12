/* eslint-disable camelcase -- 接口旧字段回归 */
jest.mock('../src/models', () => ({}));
const { getPermissionCatalog } = require('../src/constants/permissionCatalog');
const { validatePermissionSet } = require('../src/services/permissionService');
const {
  rejectLegacyBindingFields,
  bindingRetiredError,
} = require('../src/services/profileIndependence');

describe('独立档案旧输入与退役授权', () => {
  test('保留退役授权时可以撤销双方读取权限，不补授或扩权', () => {
    const retired = 'recipients.bind_apple_ids';
    expect(validatePermissionSet([retired])).toEqual([retired]);
    expect(getPermissionCatalog().find(item => item.code === retired)).toMatchObject({
      retired: true,
      dependencies: [],
    });
    expect(() => validatePermissionSet(['recipients.edit'])).toThrow('权限依赖不完整');
    expect(bindingRetiredError()).toMatchObject({
      statusCode: 410,
      code: 'PROFILE_BINDING_RETIRED',
    });
  });
  test('兼容空字段，但拒绝双向非空绑定输入', () => {
    expect(() =>
      rejectLegacyBindingFields({ appleIdRef: null, appleId: '', password: '' })
    ).not.toThrow();
    expect(() => rejectLegacyBindingFields({ recipient_id: 12 }, true)).toThrow('档案已独立维护');
    expect(() => rejectLegacyBindingFields({ appleIdRef: 1 })).toThrow('档案已独立维护');
  });
});
