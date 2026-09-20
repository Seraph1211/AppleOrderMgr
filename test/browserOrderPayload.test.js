const {
  projectBrowserOrderJson,
  findBrowserOrderJson,
  isBrowserOrderResponse,
} = require('../src/services/crawler/browserOrderPayload');
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');

test.each([
  ['https://secure8.www.apple.com.cn/shop/order/lookup?_a=fetchOrder', 'Fetch', true],
  ['https://secure8.www.apple.com.cn/shop/order/lookup?_a=fetch%4Frder', 'XHR', true],
  ['https://secure8.www.apple.com.cn/shop/order/fetchOrder', 'XHR', true],
  ['https://secure.www.apple.com.cn/shop/order/guest', 'Document', true],
  ['https://www.apple.com.cn/xc/cn/vieworder', 'Document', true],
  ['https://secure8.www.apple.com.cn/shop/order/lookup?redirect=fetchOrder', 'Fetch', false],
  ['https://secure8.www.apple.com.cn/shop/order/lookup?_a=fetchOrderExtra', 'Fetch', false],
  ['https://secure8.www.apple.com.cn/shop/order/notfetchOrder', 'Fetch', false],
  ['https://secure8.www.apple.com.cn.evil.example/?_a=fetchOrder', 'Fetch', false],
  ['https://evil.example/?_a=fetchOrder', 'Document', false],
  ['http://secure8.www.apple.com.cn/?_a=fetchOrder', 'Fetch', false],
  ['https://secure8.www.apple.com.cn:444/?_a=fetchOrder', 'Fetch', false],
  ['https://user:pass@secure8.www.apple.com.cn/?_a=fetchOrder', 'Fetch', false],
])('识别官网响应 %s %s => %s', (url, type, expected) => {
  expect(isBrowserOrderResponse(new URL(url), type)).toBe(expected);
});

test('白名单保留商品和阶段，排除订单联系资料、付款链接、凭据和非业务节点', () => {
  const json = buildLifecycleJson('PROCESSING');
  json.cookie = 'secret-cookie';
  json.orderDetail.orderHeader.d.email = 'private@example.com';
  json.orderDetail.orderHeader.payNow = {
    d: { totalAmount: 'RMB 8,999.00', paymentUrl: 'https://example.com/secret-token' },
  };
  const item = json.orderDetail.orderItems['orderItem-0000101'];
  item.shippingInfo['shipping-address'].address.d.street = 'private-address';
  item.orderItemDetails.d.hoursAndDirectionsURL = 'https://example.com/token';
  const result = projectBrowserOrderJson(json, 'W1234567890');
  const serialized = JSON.stringify(result);
  for (const sensitive of [
    'secret-cookie',
    'private@example.com',
    'secret-token',
    'private-address',
    'https://',
  ])
    expect(serialized).not.toContain(sensitive);
  expect(result.orderDetail.orderHeader).toEqual({ d: { orderNumber: 'W1234567890' } });
  expect(result.orderDetail).not.toHaveProperty('billingInfo');
  expect(result.orderDetail.orderItems['orderItem-0000101']).not.toHaveProperty('shippingInfo');
  expect(result.orderDetail.orderItems['orderItem-0000101'].orderItemDetails.d).not.toHaveProperty(
    'deliveryDate'
  );
  expect(
    result.orderDetail.orderItems['orderItem-0000101'].orderItemStatusTracker.d.currentStatus
  ).toBe('PROCESSING');
  expect(json.cookie).toBe('secret-cookie');
});

test('不根据条目数填充数量或金额，未知阶段保持原文', () => {
  const json = buildLifecycleJson('UNRECOGNIZED');
  delete json.orderDetail.orderItems['orderItem-0000101'].orderItemDetails.d.quantity;
  const result = projectBrowserOrderJson(json, 'W1234567890');
  expect(result.orderDetail.orderItems['orderItem-0000101'].orderItemDetails.d).not.toHaveProperty(
    'quantity'
  );
  expect(result.orderDetail.orderHeader).not.toHaveProperty('payNow');
  expect(
    result.orderDetail.orderItems['orderItem-0000101'].orderItemStatusTracker.d.currentStatus
  ).toBe('UNRECOGNIZED');
});

test('多商品列表不漏掉排序列表之外的有效项', () => {
  const json = buildLifecycleJson('PROCESSING');
  json.orderDetail.orderItems['orderItem-0000201'] =
    json.orderDetail.orderItems['orderItem-0000101'];
  const result = projectBrowserOrderJson(json, 'W1234567890');
  expect(result.orderDetail.orderItems.c).toHaveLength(2);
});

test('身份不一致、无商品和多订单响应拒绝', () => {
  const json = buildLifecycleJson('PROCESSING');
  expect(() => projectBrowserOrderJson(json, 'W9999999999')).toThrow();
  expect(() => findBrowserOrderJson({ one: json, two: json })).toThrow();
  json.orderDetail.orderItems = {};
  expect(() => projectBrowserOrderJson(json, 'W1234567890')).toThrow();
});

test('兼容正常响应包装但不把加载页当成订单', () => {
  const json = buildLifecycleJson('PROCESSING');
  expect(findBrowserOrderJson({ body: { content: json } })).toBe(json);
  expect(findBrowserOrderJson({ guestOrderSpinner: {} })).toBeNull();
});
