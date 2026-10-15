import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAvailableCount,
  assignmentBlockReason,
  tryClipboard,
} from '../src/pages/proxyOrders/feedback.js';

test('应该将数字与字符串空池统一为0，未知数量不得当作可用', () => {
  for (const value of [0, '0']) assert.equal(normalizeAvailableCount(value), 0);
  for (const value of [null, undefined, '', 'invalid', -1, 1.5])
    assert.equal(normalizeAvailableCount(value), null);
  assert.equal(normalizeAvailableCount('12'), 12);
});

test('应该阻止空池、未知数量、越界及超库存自动分配，并给出说明', () => {
  assert.match(assignmentBlockReason(0, 1, ''), /暂无可用账号/);
  assert.match(assignmentBlockReason(null, 1, ''), /未获取/);
  assert.match(assignmentBlockReason(3, 0, ''), /整数/);
  assert.match(assignmentBlockReason(3, 4, ''), /不足/);
  assert.equal(assignmentBlockReason(3, 2, ''), '');
  assert.equal(assignmentBlockReason(3, 1, '42'), '');
});

test('应该区分复制成功、权限拒绝、接口缺失及超时，供页面提供手动复制', async () => {
  assert.equal(
    await tryClipboard('fixture', { writeText: async value => assert.equal(value, 'fixture') }),
    true
  );
  assert.equal(
    await tryClipboard('fixture', {
      writeText: async () => {
        throw new Error('denied');
      },
    }),
    false
  );
  assert.equal(await tryClipboard('fixture', undefined), false);
  assert.equal(await tryClipboard('fixture', { writeText: () => new Promise(() => {}) }, 5), false);
});
