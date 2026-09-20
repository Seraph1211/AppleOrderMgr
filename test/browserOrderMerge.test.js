const { mergeBrowserOrder } = require('../src/services/crawler/browserOrderMerge');

function fixture() {
  return {
    order: {
      status: 'pending',
      paymentStatus: 'unknown',
      pickupStore: '原门店',
      paymentMethod: '原付款方式',
      officialOrderAmount: '8999.00',
      products: [{ name: '测试手机 256GB 蓝色', model: 'TESTSKU', quantity: 1 }],
      officialFieldDiagnostics: { amount: 'value', paymentMethod: 'value' },
      validationIssues: [{ type: 'source_conflict', field: 'pickupStore', message: '原门店差异' }],
    },
    data: {
      orderStatus: 'processing',
      officialRawStatus: 'PROCESSING',
      officialStatusDescription: 'PROCESSING_IMM_PICKUP',
      productsComplete: true,
      products: [{ name: '测试手机 256GB 蓝色', quantity: 2, status: 'PROCESSING' }],
      paymentStatus: 'paid',
      pickupStatus: 'not_ready',
      pickupStore: '新门店',
      officialPaymentMethod: '新付款方式',
      officialOrderAmount: 9999,
      officialOrderAmountCurrency: 'USD',
      officialPaymentExpiresAt: new Date(),
      officialOrderCreatedAt: new Date(),
      officialFieldDiagnostics: { amount: 'invalid', statusDescription: 'value' },
      officialOrderAmountParseError: '不在本次范围',
    },
  };
}

test('旧客户端多传字段也只回写状态商品，保留其他校验问题与诊断', () => {
  const { order, data } = fixture();
  const before = JSON.stringify(order);
  const update = mergeBrowserOrder(order, data);
  expect(update).toMatchObject({
    status: 'processing',
    officialRawStatus: 'PROCESSING',
    officialStatusDescription: 'PROCESSING_IMM_PICKUP',
    products: [{ name: '测试手机 256GB 蓝色', model: 'TESTSKU', quantity: 2 }],
    officialFieldDiagnostics: {
      amount: 'value',
      paymentMethod: 'value',
      statusDescription: 'value',
    },
  });
  for (const key of [
    'paymentStatus',
    'pickupStatus',
    'pickupStore',
    'paymentMethod',
    'officialPaymentMethod',
    'officialOrderAmount',
    'officialOrderAmountCurrency',
    'officialOrderAmountParseError',
    'officialPaymentExpiresAt',
    'officialOrderCreatedAt',
  ])
    expect(update).not.toHaveProperty(key);
  expect(update.validationIssues).toContainEqual(order.validationIssues[0]);
  expect(update.validationIssues).toContainEqual(
    expect.objectContaining({ field: 'products.0.quantity' })
  );
  expect(JSON.stringify(order)).toBe(before);
});

test('只提供状态、名称、数量即可成功，非商品历史异常不会被清空', () => {
  const { order } = fixture();
  const update = mergeBrowserOrder(order, {
    orderStatus: 'processing',
    productsComplete: true,
    products: order.products,
  });
  expect(update.products).toEqual(order.products);
  expect(update.validationIssues).toEqual(order.validationIssues);
  expect(update.validationStatus).toBe('abnormal');
});

test('缺失数量不覆盖商品，未知阶段保留待核对标志', () => {
  const { order, data } = fixture();
  data.products = [{ name: '测试手机', quantity: null }];
  data.productsComplete = false;
  data.officialStatusNeedsReview = true;
  const update = mergeBrowserOrder(order, data);
  expect(update).not.toHaveProperty('products');
  expect(update).not.toHaveProperty('officialProducts');
  expect(update.officialStatusNeedsReview).toBe(true);
  expect(update.validationStatus).toBe('abnormal');
});

test('商品与状态已无异常时仅清除对应旧问题', () => {
  const { order } = fixture();
  order.validationIssues = [
    { type: 'parse_field', field: 'products' },
    { type: 'status_review', field: 'status' },
  ];
  const update = mergeBrowserOrder(order, {
    orderStatus: 'processing',
    products: order.products,
    productsComplete: true,
  });
  expect(update.validationIssues).toEqual([]);
  expect(update.validationStatus).toBe('valid');
  expect(update.anomalyDetectedAt).toBeNull();
});
