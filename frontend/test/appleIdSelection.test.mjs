import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAppleIdSelection } from '../src/utils/appleIdBatch.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}
function context() {
  const state = { ids: new Set([8]), loading: false, error: '' };
  return {
    state,
    options: {
      generation: { current: 0 },
      onSelected: ids => {
        state.ids = ids;
      },
      onLoading: loading => {
        state.loading = loading;
      },
      onError: error => {
        state.error = error;
      },
    },
  };
}
test('筛选全选保存接口 ID 快照，替换原选集而不依赖当前页', async () => {
  const { state, options } = context();
  await loadAppleIdSelection({
    ...options,
    fetchIds: async () => ({ success: true, data: { ids: [1, 2, 3], total: 3 } }),
  });
  assert.deepEqual([...state.ids], [1, 2, 3]);
  assert.equal(state.loading, false);
  assert.equal(state.error, '');
});
test('筛选改变或取消后，迟到成功不能恢复旧选集', async () => {
  const { state, options } = context();
  const request = deferred();
  const pending = loadAppleIdSelection({ ...options, fetchIds: () => request.promise });
  options.generation.current += 1;
  state.ids = new Set();
  state.loading = false;
  request.resolve({ success: true, data: { ids: [1, 2], total: 2 } });
  await pending;
  assert.deepEqual([...state.ids], []);
  assert.equal(state.loading, false);
});
test('新选择请求优先，旧成功/旧失败均不能覆盖新状态', async () => {
  for (const staleFailure of [false, true]) {
    const { state, options } = context();
    const oldRequest = deferred();
    const oldPending = loadAppleIdSelection({ ...options, fetchIds: () => oldRequest.promise });
    await loadAppleIdSelection({
      ...options,
      fetchIds: async () => ({ success: true, data: { ids: [9], total: 1 } }),
    });
    if (staleFailure) oldRequest.reject(new Error('旧失败'));
    else oldRequest.resolve({ success: true, data: { ids: [1], total: 1 } });
    await oldPending;
    assert.deepEqual([...state.ids], [9]);
    assert.equal(state.error, '');
    assert.equal(state.loading, false);
  }
});
test('异常、不完整和超5000结果失败且不破坏原选集，可显式重试', async () => {
  for (const data of [
    { ids: [1], total: 2 },
    { ids: [1, 1], total: 2 },
    { ids: [0], total: 1 },
    { ids: Array.from({ length: 5001 }, (_, index) => index + 1), total: 5001 },
  ]) {
    const { state, options } = context();
    await loadAppleIdSelection({ ...options, fetchIds: async () => ({ success: true, data }) });
    assert.deepEqual([...state.ids], [8]);
    assert.ok(state.error);
    assert.equal(state.loading, false);
    await loadAppleIdSelection({
      ...options,
      fetchIds: async () => ({ success: true, data: { ids: [2], total: 1 } }),
    });
    assert.deepEqual([...state.ids], [2]);
    assert.equal(state.error, '');
  }
});
