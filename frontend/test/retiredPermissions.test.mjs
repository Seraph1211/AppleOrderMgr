import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changePermissionSelection,
  preserveRetiredPermissions,
} from '../src/utils/permissionSelection.js';

const retiredCode = 'recipients.bind_apple_ids';
const catalog = [
  { code: 'recipients.read', dependencies: [] },
  { code: 'apple_ids.read', dependencies: [] },
  { code: 'orders.read', dependencies: [] },
  { code: 'orders.edit', dependencies: ['orders.read'] },
  { code: retiredCode, retired: true, dependencies: ['recipients.read', 'apple_ids.read'] },
];
const visibleCatalog = catalog.filter(item => !item.retired);

test('修改其他权限保存时保留隐藏的原停用授权，不额外补授旧依赖', () => {
  const initial = [retiredCode, 'orders.read'];
  const changed = changePermissionSelection(initial, visibleCatalog, ['orders.edit'], true);
  assert.deepEqual(preserveRetiredPermissions(changed, initial, catalog), [
    'orders.read',
    'orders.edit',
    retiredCode,
  ]);
  assert.deepEqual(initial, [retiredCode, 'orders.read']);
});

test('撤销基础权限或清空预设保留原停用权限，但不阻止撤销实际读取权限', () => {
  const initial = [retiredCode, 'recipients.read', 'apple_ids.read'];
  const changed = changePermissionSelection(initial, visibleCatalog, ['recipients.read'], false);
  assert.deepEqual(preserveRetiredPermissions(changed, initial, catalog), [
    'apple_ids.read',
    retiredCode,
  ]);
  assert.deepEqual(preserveRetiredPermissions([], initial, catalog), [retiredCode]);
});

test('付款预设保留停用授权；原本没有停用授权的用户不能被新增该权限', () => {
  const initial = [retiredCode, 'orders.edit'];
  assert.deepEqual(preserveRetiredPermissions(['payment_tasks.read_own'], initial, catalog), [
    'payment_tasks.read_own',
    retiredCode,
  ]);
  assert.deepEqual(preserveRetiredPermissions([retiredCode, 'orders.read'], [], catalog), [
    'orders.read',
  ]);
  assert(!visibleCatalog.some(item => item.code === retiredCode));
});
