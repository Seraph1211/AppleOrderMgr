const { getStockPermissionGroups } = require('../src/constants/stockPermissionGroups');
const { getPermissionCatalog } = require('../src/constants/permissionCatalog');
const { validatePermissionSet } = require('../src/services/permissionService');
const { getCatalog } = require('../src/controllers/permissionController');

describe('库存业务分组与旧权限契约', () => {
  test('目录新增六组但保留全部原权限码和依赖', () => {
    const res = { json: jest.fn() };
    getCatalog({}, res);
    const { data } = res.json.mock.calls[0][0];
    expect(data.version).toBe(2);
    expect(data.stockGroups).toHaveLength(6);
    expect(data.permissions).toEqual(getPermissionCatalog());
  });
  test('所有分组展开后通过服务端真实授权校验', () => {
    const catalog = getPermissionCatalog();
    for (const group of getStockPermissionGroups()) {
      for (const option of group.options) {
        const selected = new Set();
        const add = code => {
          if (selected.has(code)) return;
          selected.add(code);
          catalog.find(item => item.code === code).dependencies.forEach(add);
        };
        option.codes.forEach(add);
        expect(validatePermissionSet([...selected])).toEqual([...selected].sort());
      }
    }
  });
  test('旧账号成本只读集合原样保留，缺依赖和越权仍拒绝', () => {
    expect(validatePermissionSet(['stock.read', 'stock.cost.read'])).toEqual([
      'stock.cost.read',
      'stock.read',
    ]);
    expect(() => validatePermissionSet(['stock.sales.ship'])).toThrow('权限依赖不完整');
    expect(() => validatePermissionSet(['stock.settings.manage', 'stock.read'])).toThrow(
      '管理员保留'
    );
    expect(() => validatePermissionSet(['stock.manage'])).toThrow('未知权限码');
  });
});
