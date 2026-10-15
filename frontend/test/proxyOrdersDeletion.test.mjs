import test from 'node:test';
import assert from 'node:assert/strict';
import { activeAssignmentCount, pageAfterDeletion } from '../src/pages/proxyOrders/deletion.js';

test('应该仅对活跃账号占用要求停抢确认，保留历史不重复计入', () => {
  assert.equal(activeAssignmentCount({ assignments: [] }), 0);
  assert.equal(activeAssignmentCount({ assignments: [{ endedAt: '2026-10-16' }] }), 0);
  assert.equal(
    activeAssignmentCount({ assignments: [{ endedAt: null }, {}, { endedAt: '2026-10-16' }] }),
    2
  );
});

test('应该删除末页唯一记录后回退，保留其他页和不相关删除的页码', () => {
  assert.equal(pageAfterDeletion(3, [{ id: 61 }], 61), 2);
  assert.equal(pageAfterDeletion(1, [{ id: 1 }], 1), 1);
  assert.equal(pageAfterDeletion(2, [{ id: 31 }, { id: 32 }], 31), 2);
  assert.equal(pageAfterDeletion(2, [{ id: 31 }], 32), 2);
});
