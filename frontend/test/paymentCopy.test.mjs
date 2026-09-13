import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentCopyText } from '../src/utils/paymentCopy.js';

test('同名同型号商品合并数量，单条及批量共用格式，不修改源记录', () => {
  const name = 'iPhone 18 Pro Max 512GB 勃艮第酒红色';
  const task = { orderId: 183, paymentMethod: 'wechat', products: [
    { name, model: 'MODEL-A', quantity: 1 }, { name, model: 'MODEL-A', quantity: 1 },
  ] };
  const original = JSON.stringify(task);
  assert.equal(buildPaymentCopyText(task, 'https://example.com/order'),
    `183 || ${name} x 2 || 微信 || https://example.com/order`);
  assert.equal(JSON.stringify(task), original);
});
test('非相邻重复项累加并保留首次顺序，不合并不同型号或名称', () => {
  const task = { orderId: 1, products: [
    { name: ' A ', model: 'M1', quantity: '2' },
    { name: 'B', model: 'M2', quantity: 1 },
    { name: 'A', model: 'M1', quantity: 3 },
    { name: 'A', model: 'M3', quantity: 1 },
    { model: 'M4' }, { model: 'M4' },
  ] };
  assert.equal(buildPaymentCopyText(task, 'url'), '1 || A x 5、B x 1、A x 1、M4 x 2 || - || url');
  assert.equal(buildPaymentCopyText({ orderId: 1, products: [null, {}] }, 'url'), '1 || - || - || url');
});
