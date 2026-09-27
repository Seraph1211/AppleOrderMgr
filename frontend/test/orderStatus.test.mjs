import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMAIL_ORDER_STATUS_BADGES,
  ORDER_STATUS_LABELS,
  getEmailOrderStatusBadge,
  getOrderStatusBadge,
  getDisplayOrderStatusBadge,
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

test('邮件阶段保留既有颜色，新增部分取消与两种终态', () => {
  const classes = Object.values(EMAIL_ORDER_STATUS_BADGES).map(item => item.class);
  assert.equal(new Set(classes).size, 7);
  assert.equal(Object.keys(EMAIL_ORDER_STATUS_BADGES).length, 8);
  assert.equal(getEmailOrderStatusBadge('ready_for_pickup').class, 'badge-success');
  assert.equal(getEmailOrderStatusBadge('picked_up').text, '已取货');
  assert.equal(getEmailOrderStatusBadge('bad').text, '待确认');
});

test('付款超时与 Apple 邮件过期、取消使用独立状态标签', () => {
  assert.equal(getDisplayOrderStatusBadge('payment_timeout').text, '付款超时');
  assert.equal(getDisplayOrderStatusBadge('partially_cancelled').text, '部分取消');
  assert.equal(getEmailOrderStatusBadge('expired').text, '已过期');
  assert.equal(getEmailOrderStatusBadge('cancelled').text, '已取消');
  assert.equal(getDisplayOrderStatusBadge('expired').text, '已过期');
  assert.equal(getDisplayOrderStatusBadge('cancelled').text, '已取消');
});
