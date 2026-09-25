import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMAIL_ORDER_STATUS_BADGES,
  ORDER_STATUS_LABELS,
  getEmailOrderStatusBadge,
  getOrderStatusBadge,
} from '../src/constants/orderStatus.js';

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

test('邮件订单状态五种标签使用不同颜色', () => {
  const classes = Object.values(EMAIL_ORDER_STATUS_BADGES).map(item => item.class);
  assert.equal(new Set(classes).size, 5);
  assert.equal(getEmailOrderStatusBadge('ready_for_pickup').class, 'badge-success');
  assert.equal(getEmailOrderStatusBadge('picked_up').text, '已取货（邮件推定）');
  assert.equal(getEmailOrderStatusBadge('bad').text, '待确认');
});
