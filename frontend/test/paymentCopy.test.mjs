import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentCopyText } from '../src/utils/paymentCopy.js';

test('同名同型号商品合并数量，单条及批量共用格式，不修改源记录', () => {
  const name = 'iPhone 18 Pro Max 512GB 勃艮第酒红色';
  const task = {
    orderId: 183,
    paymentMethod: 'wechat',
    products: [
      { name, model: 'MODEL-A', quantity: 1 },
      { name, model: 'MODEL-A', quantity: 1 },
    ],
  };
  const original = JSON.stringify(task);
  assert.equal(
    buildPaymentCopyText(task, 'https://example.com/order'),
    `183 || ${name} x 2 || 微信 || - || https://example.com/order`
  );
  assert.equal(JSON.stringify(task), original);
});
test('非相邻重复项累加并保留首次顺序，不合并不同型号或名称', () => {
  const task = {
    orderId: 1,
    products: [
      { name: ' A ', model: 'M1', quantity: '2' },
      { name: 'B', model: 'M2', quantity: 1 },
      { name: 'A', model: 'M1', quantity: 3 },
      { name: 'A', model: 'M3', quantity: 1 },
      { model: 'M4' },
      { model: 'M4' },
    ],
  };
  assert.equal(
    buildPaymentCopyText(task, 'url'),
    '1 || A x 5、B x 1、A x 1、M4 x 2 || - || - || url'
  );
  assert.equal(
    buildPaymentCopyText({ orderId: 1, products: [null, {}] }, 'url'),
    '1 || - || - || - || url'
  );
});

test('来源下单时间加30分钟，UTC和带时区时间一致，跨日补零', () => {
  const task = {
    orderId: 272,
    products: [{ name: 'iPhone 18 Pro Max 勃艮第酒红色 512G', quantity: 2 }],
    paymentMethod: 'alipay',
    deadlineAt: '2026-09-20T15:00:00Z',
    officialOrderCreatedAt: '2026-09-20T14:00:00Z',
  };
  for (const orderDate of ['2026-09-20T13:02:59Z', '2026-09-20T21:02:59+08:00']) {
    assert.equal(
      buildPaymentCopyText({ ...task, orderDate }, 'https://example.com/order/272'),
      '272 || iPhone 18 Pro Max 勃艮第酒红色 512G x 2 || 支付宝 || 26/09/20 21:32 || https://example.com/order/272'
    );
  }
  assert.match(
    buildPaymentCopyText({ ...task, orderDate: '2026-09-20T15:35:00Z' }, 'url'),
    /支付宝 \|\| 26\/09\/21 00:05 \|\| url$/
  );
});

test('来源时间缺失或不完整时不回退官网，官网失败和终态不影响来源截止', () => {
  for (const orderDate of [
    null,
    undefined,
    '',
    'invalid',
    '2026-09-20',
    '2026-99-99T13:00:00Z',
    '2026-09-20T13:00:00',
  ]) {
    assert.equal(
      buildPaymentCopyText(
        {
          orderId: 1,
          orderDate,
          deadlineAt: '2026-09-20T13:32:00Z',
          officialOrderCreatedAt: '2026-09-20T13:02:00Z',
        },
        'url'
      ),
      '1 || - || - || - || url'
    );
  }
  for (const officialOrderStatus of ['payment_due', 'payment_received']) {
    assert.equal(
      buildPaymentCopyText(
        {
          orderId: 1,
          orderDate: '2026-09-19T21:58:49+08:00',
          deadlineAt: null,
          officialOrderStatus,
        },
        'url'
      ),
      '1 || - || - || 26/09/19 22:28 || url'
    );
  }
});

test('截止时间跨年后使用新日期，月日和时分补零', () => {
  assert.equal(
    buildPaymentCopyText({ orderId: 1, orderDate: '2026-12-31T23:38:00+08:00' }, 'url'),
    '1 || - || - || 27/01/01 00:08 || url'
  );
});
