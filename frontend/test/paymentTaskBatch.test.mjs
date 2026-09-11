import test from 'node:test';
import assert from 'node:assert/strict';
import { updateSelectedTaskStatuses } from '../src/utils/paymentTaskBatch.js';

test('逐单隔离失败、保留版本与原备注，不提交其他草稿、不自动重试', async () => {
  const calls = [];
  let sequence = 0;
  const tasks = [1, 2, 3].map(id => ({
    id,
    orderId: 100 + id,
    version: id + 5,
    processingNotes: '原备注',
    payerName: '不得提交',
  }));
  const result = await updateSelectedTaskStatuses(
    tasks,
    'completed',
    ' ',
    async (id, payload, key) => {
      calls.push({ id, payload, key });
      if (id === 2) throw new Error('任务已被更新');
      return { data: { ...tasks[id - 1], processingStatus: 'completed' } };
    },
    () => `key-${++sequence}`
  );
  assert.deepEqual(
    result.map(item => item.success),
    [true, false, true]
  );
  assert.equal(result[1].message, '任务已被更新');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].payload, { processingStatus: 'completed', expectedVersion: 6 });
  assert.equal(new Set(calls.map(call => call.key)).size, 3);
  assert.equal(result[0].task.processingStatus, 'completed');
});

test('显式统一备注去除首尾空白；空选择不发请求', async () => {
  let captured;
  await updateSelectedTaskStatuses(
    [{ id: 9, version: 4 }],
    'exception',
    ' 原因 ',
    async (_, payload) => {
      captured = payload;
      return { data: {} };
    },
    () => 'key'
  );
  assert.deepEqual(captured, {
    processingStatus: 'exception',
    expectedVersion: 4,
    processingNotes: '原因',
  });
  assert.deepEqual(
    await updateSelectedTaskStatuses(
      [],
      'processing',
      '',
      () => {
        throw new Error('不应调用');
      },
      () => 'key'
    ),
    []
  );
});
