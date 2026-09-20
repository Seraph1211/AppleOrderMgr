import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileRowRefresh,
  applyRefreshJobResult,
  getOrderRefreshFeedback,
} from '../src/utils/orderRefresh.js';

const oldTime = '2026-09-19T00:00:00Z';
const newTime = '2026-09-19T00:01:00Z';
const failure = {
  jobId: 1,
  status: 'failed',
  finishedAt: oldTime,
  errorCode: 'PAGE_LOADING',
  message: '旧错误',
};

test('后台后续成功移除旧失败，本地成功时间不能被旧列表覆盖', () => {
  const order = {
    id: 1,
    refreshLastSuccessAt: newTime,
    refreshLastFailureAt: oldTime,
    freshnessStatus: 'fresh',
  };
  assert.deepEqual(reconcileRowRefresh({ 1: failure }, [order]), {});
  assert.equal(getOrderRefreshFeedback(order, failure).status, null);
  const local = { ...failure, status: 'succeeded', finishedAt: newTime, message: '' };
  assert.equal(
    getOrderRefreshFeedback(
      { ...order, freshnessStatus: 'failed', refreshLastSuccessAt: null },
      local
    ).status,
    'succeeded'
  );
});

test('旧任务轮询不能覆盖新提交、新任务或已完成状态', () => {
  for (const local of [
    { status: 'submitting' },
    { jobId: 2, status: 'running' },
    { jobId: 1, status: 'succeeded' },
  ]) {
    const state = { 1: local };
    assert.equal(applyRefreshJobResult(state, { orderId: 1, jobId: 1, status: 'failed' }), state);
  }
});

test('服务端较新任务替换旧本地任务，同任务正常推进并保留结束时间', () => {
  const order = { id: 1, refreshJob: { id: 2, status: 'pending' } };
  assert.deepEqual(reconcileRowRefresh({ 1: failure }, [order]), {});
  assert.equal(getOrderRefreshFeedback(order, failure).busy, true);
  const next = applyRefreshJobResult(
    { 1: { jobId: 2, status: 'running' } },
    {
      orderId: 1,
      jobId: 2,
      status: 'failed',
      finishedAt: newTime,
      lastErrorCode: 'REQUEST_TIMEOUT',
      lastErrorMessage: '已尝试 2 次',
    }
  );
  assert.equal(next[1].finishedAt, newTime);
  assert.equal(getOrderRefreshFeedback({ id: 1 }, next[1]).label, '连接超时，可重试');
});

test('重载后服务端失败仍可读，新成功消除旧失败，身份异常单独强调', () => {
  const order = {
    id: 1,
    freshnessStatus: 'failed',
    refreshLastFailureAt: newTime,
    refreshLastSuccessAt: oldTime,
    refreshErrorCode: 'IDENTITY',
    refreshErrorMessage: '身份不符',
  };
  const feedback = getOrderRefreshFeedback(order);
  assert.equal(feedback.status, 'failed');
  assert.equal(feedback.isIdentityError, true);
  assert.equal(feedback.lastSuccessAt, oldTime);
  assert.equal(
    getOrderRefreshFeedback({ ...order, refreshLastSuccessAt: '2026-09-19T00:02:00Z' }).status,
    null
  );
});

test('订单接口返回旧快照时不清除正在提交的状态', () => {
  const previous = { 1: { status: 'submitting' } };
  assert.equal(reconcileRowRefresh(previous, [{ id: 1, refreshJob: { id: 2 } }]), previous);
});

test('提交请求失败提示仅由更新的服务端结果清除，已有旧成功不误清除', () => {
  const local = {
    status: 'failed',
    observedBeforeSubmit: Date.parse(oldTime),
    message: '提交未确认',
  };
  assert.equal(
    getOrderRefreshFeedback({ id: 1, refreshLastSuccessAt: oldTime }, local).status,
    'failed'
  );
  assert.equal(
    getOrderRefreshFeedback({ id: 1, refreshLastSuccessAt: newTime }, local).status,
    null
  );
  assert.equal(
    getOrderRefreshFeedback({ id: 1, freshnessStatus: 'failed', refreshErrorCode: '__proto__' })
      .label,
    '刷新未完成，可重试'
  );
});
