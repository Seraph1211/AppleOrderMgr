import test from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_STATUS_LABELS, getOrderStatusBadge } from '../src/constants/orderStatus.js';

test('官网状态文案与非法值兜底一致，不影响人工四态', () => {
  assert.equal(ORDER_STATUS_LABELS.pending, '待处理');
  assert.equal(ORDER_STATUS_LABELS.unknown, 'unknown');
  assert.equal(Object.keys(ORDER_STATUS_LABELS).length, 12);
  assert.equal(Object.hasOwn(ORDER_STATUS_LABELS, 'completed'), false);
  for (const status of ['completed', 'bad', 'constructor', '__proto__', null, undefined]) {
    assert.equal(getOrderStatusBadge(status).text, 'unknown');
  }
  assert.equal(getOrderStatusBadge('picked_up').text, '已取货');
  assert.equal(getOrderStatusBadge('payment_expired').class, 'badge-error');
});
