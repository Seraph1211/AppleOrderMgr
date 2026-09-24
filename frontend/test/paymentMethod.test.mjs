import test from 'node:test';
import assert from 'node:assert/strict';
import { isAlipayPayment, isWechatPayment } from '../src/utils/paymentMethod.js';

test('微信和支付宝仅命中各自的普通方式及明确别名', () => {
  for (const method of ['微信', '微信支付', 'wechat', 'WECHAT PAY']) {
    assert.equal(isWechatPayment(method), true);
    assert.equal(isAlipayPayment(method), false);
  }
  for (const method of ['支付宝', 'alipay', ' ALIPAY ']) {
    assert.equal(isAlipayPayment(method), true);
    assert.equal(isWechatPayment(method), false);
  }
  for (const method of ['支付宝银行12期', '花呗12期', '微信分付12期', '', null]) {
    assert.equal(isAlipayPayment(method), false);
    assert.equal(isWechatPayment(method), false);
  }
});
