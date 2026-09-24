const {
  PAYMENT_METHODS,
  isAlipayPayment,
  isWechatPayment,
  getSourcePaymentMethod,
  normalizePaymentMethod,
} = require('../src/utils/paymentMethod');
const { serializeTask } = require('../src/services/paymentTaskService');

test.each(PAYMENT_METHODS)('%s 分类只接受普通微信付款码', method => {
  expect(isWechatPayment(method)).toBe(method === '微信');
  expect(isAlipayPayment(method)).toBe(method === '支付宝');
});

test.each(['花呗24期', '微信分付', '招行36期', '', null])('未知方式 %s 不冒充已支持', method => {
  expect(normalizePaymentMethod(method)).toBeNull();
  expect(isWechatPayment(method)).toBe(false);
  expect(isAlipayPayment(method)).toBe(false);
});

test('来源快照优先且不改写订单，空快照回退当前值', () => {
  const order = { paymentMethod: 'WECHAT', sourceSnapshot: { paymentMethod: '微信分付24期' } };
  expect(getSourcePaymentMethod(order)).toBe('微信分付24期');
  expect(order.paymentMethod).toBe('WECHAT');
  expect(getSourcePaymentMethod({ paymentMethod: 'VISA', sourceSnapshot: {} })).toBe('VISA');
  expect(getSourcePaymentMethod({ sourceSnapshot: { paymentMethod: ' ' } })).toBeNull();
});

test('任务 DTO 恢复来源付款方式且不泄露来源快照', () => {
  const order = {
    paymentMethod: 'WECHAT',
    sourceSnapshot: { paymentMethod: '微信分付12期', products: [{ name: '不公开的快照' }] },
  };
  const task = { toJSON: () => ({ id: 1, orderId: 2, order }) };
  const dto = serializeTask(task);
  expect(dto.paymentMethod).toBe('微信分付12期');
  expect(dto).not.toHaveProperty('sourceSnapshot');
  expect(JSON.stringify(dto)).not.toContain('不公开的快照');
});
