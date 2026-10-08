import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  changePermissionSelection,
  getPermissionSelectionState,
} from '../src/utils/permissionSelection.js';
const require = createRequire(import.meta.url);
const { getPermissionCatalog } = require('../../src/constants/permissionCatalog.js');
const { getStockPermissionGroups } = require('../../src/constants/stockPermissionGroups.js');
const catalog = getPermissionCatalog();
const groups = getStockPermissionGroups();
const option = (id, action) =>
  groups.find(g => g.id === id).options.find(o => o.id === action).codes;

test('销售一次授权补齐递归依赖且不授予敏感金额或其他业务', () => {
  const result = changePermissionSelection([], catalog, option('sales', 'edit'), true);
  assert.deepEqual(
    result.sort(),
    [
      'stock.import',
      'stock.read',
      'stock.sales.edit',
      'stock.sales.read',
      'stock.sales.ship',
    ].sort()
  );
});
test('成本利润与货款相互独立', () => {
  const finance = changePermissionSelection([], catalog, option('finance', 'edit'), true);
  assert(finance.includes('stock.cost.read'));
  assert(finance.includes('stock.profit.read'));
  assert(
    !finance.some(code => code.startsWith('stock.receipts') || code.startsWith('stock.collections'))
  );
  const payments = changePermissionSelection([], catalog, option('payments', 'edit'), true);
  assert(payments.includes('stock.receipts.read'));
  assert(payments.includes('stock.collections.read'));
  assert(!payments.some(code => /cost|profit|expenses/.test(code)));
});
test('撤销基础读取递归撤销所有关联操作并保留无关权限', () => {
  const full = groups.flatMap(g => g.options.flatMap(o => o.codes));
  const granted = changePermissionSelection(['inventory.read', 'orders.read'], catalog, full, true);
  const result = changePermissionSelection(granted, catalog, ['stock.read'], false);
  assert(!result.some(code => code.startsWith('stock.')));
  assert(result.includes('orders.read'));
  assert(result.includes('inventory.read'));
});
test('旧账号部分权限回显不变，修改其他模块不补齐整组', () => {
  const previous = ['stock.read', 'stock.cost.read'];
  assert.equal(getPermissionSelectionState(previous, option('finance', 'read')), 'partial');
  const result = changePermissionSelection(previous, catalog, ['inventory.read'], true);
  assert.deepEqual(previous, ['stock.read', 'stock.cost.read']);
  assert(!result.includes('stock.profit.read'));
  assert.equal(getPermissionSelectionState(result, option('finance', 'read')), 'partial');
});
test('特殊分工仅登记客户付款不会获得公司到账', () => {
  const result = changePermissionSelection([], catalog, ['stock.collections.edit'], true);
  assert.equal(getPermissionSelectionState(result, option('payments', 'edit')), 'partial');
  assert(!result.includes('stock.receipts.edit'));
});
test('拒绝未知与管理员保留权限；反复勾选不重复', () => {
  assert.deepEqual(
    changePermissionSelection([], catalog, ['unknown', 'stock.settings.manage'], true),
    []
  );
  const once = changePermissionSelection([], catalog, option('sales', 'edit'), true);
  assert.deepEqual(changePermissionSelection(once, catalog, option('sales', 'edit'), true), once);
});
test('全部组合满足服务端目录依赖，库存组不包含财务权限', () => {
  for (const group of groups)
    for (const item of group.options) {
      const result = changePermissionSelection([], catalog, item.codes, true);
      for (const code of result)
        for (const dependency of catalog.find(p => p.code === code).dependencies) {
          assert(result.includes(dependency), `${code} missing ${dependency}`);
        }
    }
  const result = changePermissionSelection([], catalog, option('inventory', 'manage'), true);
  assert(result.includes('orders.read'));
  assert(result.includes('pickups.edit'));
  assert(!result.some(code => /cost|profit|expenses|collections|receipts/.test(code)));
});
