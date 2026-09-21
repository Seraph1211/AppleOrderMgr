const {
  PAYMENT_METHODS,
  isWechatPayment,
  getSourcePaymentMethod,
  normalizePaymentMethod,
} = require('../src/utils/paymentMethod');
const { mergeOfficialOrder } = require('../src/services/crawler/officialOrderData');
const { serializeTask } = require('../src/services/paymentTaskService');
const { serializeValidationIssues } = require('../src/utils/orderSerialization');

test.each(PAYMENT_METHODS)('%s 分类只接受普通微信付款码', method => {
  expect(isWechatPayment(method)).toBe(method === '微信');
});
test.each(['花呗24期', '微信分付', '招行36期', '', null])('未知方式 %s 不冒充已支持', method => {
  expect(normalizePaymentMethod(method)).toBeNull();
  expect(isWechatPayment(method)).toBe(false);
});
test('来源快照优先且不改写订单，空快照回退当前值', () => {
  const order = { paymentMethod: 'WECHAT', sourceSnapshot: { paymentMethod: '微信分付24期' } };
  expect(getSourcePaymentMethod(order)).toBe('微信分付24期');
  expect(order.paymentMethod).toBe('WECHAT');
  expect(getSourcePaymentMethod({ paymentMethod: 'VISA', sourceSnapshot: {} })).toBe('VISA');
  expect(getSourcePaymentMethod({ sourceSnapshot: { paymentMethod: ' ' } })).toBeNull();
});
test.each(PAYMENT_METHODS)('官网刷新保留来源 %s 及差异核对', paymentMethod => {
  const order = { paymentMethod, products: [] };
  const data = { orderStatus: 'pending', officialPaymentMethod: '银行卡' };
  const next = mergeOfficialOrder(order, data);
  expect(next.paymentMethod).toBe(paymentMethod);
  expect(next.officialPaymentMethod).toBe('银行卡');
  expect(next.sourceSnapshot.paymentMethod).toBe(paymentMethod);
  const issue = next.validationIssues.find(item => item.field === 'paymentMethod');
  expect(issue.resolution).toBe('source');
  expect(serializeValidationIssues([issue])[0].resolution).toBe('source');
  expect(mergeOfficialOrder({ ...order, ...next }, data).paymentMethod).toBe(paymentMethod);
});
test('历史覆盖订单在任务 DTO 只恢复付款方式，不泄露来源快照', () => {
  const order = {
    paymentMethod: 'WECHAT',
    sourceSnapshot: { paymentMethod: '微信分付12期', products: [{ name: '不公开的快照' }] },
  };
  const task = { toJSON: () => ({ id: 1, orderId: 2, order }) };
  const dto = serializeTask(task);
  expect(dto.paymentMethod).toBe('微信分付12期');
  expect(dto).not.toHaveProperty('sourceSnapshot');
  expect(JSON.stringify(dto)).not.toContain('不公开的快照');
  expect(mergeOfficialOrder(order, { orderStatus: 'pending' }).paymentMethod).toBe('微信分付12期');
});
test('来源为空时兼容官网方式兜底', () => {
  expect(
    mergeOfficialOrder({ products: [] }, { orderStatus: 'pending', officialPaymentMethod: 'VISA' })
      .paymentMethod
  ).toBe('VISA');
});
