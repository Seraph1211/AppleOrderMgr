jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/utils/telegramNotifier', () => ({ sendTelegramAlert: jest.fn() }));
const { buildLifecycleJson, buildLifecycleHtml } = require('./fixtures/officialOrderLifecycle');
const { parseOrderData, extractOrderJson } = require('../src/services/crawlerService');
const {
  mergeOfficialOrder,
  parseOfficialMoney,
  getOfficialDeadline,
  isPaymentBlocked,
  summarizeLifecycle,
  safeText,
} = require('../src/services/crawler/officialOrderData');
const { isAutoRefreshEligible } = require('../src/services/crawler/refreshPolicy');
const { serializeTask } = require('../src/services/paymentTaskService');
const {
  serializeOfficialFields,
  serializeValidationIssues,
  serializePublicProducts,
} = require('../src/utils/orderSerialization');
const parse = (status, options) => {
  const html = buildLifecycleHtml(status, options);
  return parseOrderData(extractOrderJson(html), html);
};
const sourceOrder = () => ({
  orderNumber: 'W1234567890',
  orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test@example.com',
  products: [{ name: '测试手机 256GB 蓝色', model: 'MODEL-1', quantity: 2 }],
  paymentMethod: '银行卡',
  autoRefreshEnabled: true,
});

describe('官网生命周期和来源合并', () => {
  test('下单日期节点消失后已有来源差异仍可查看', () => {
    const original = { ...sourceOrder(), orderDate: new Date('2026-09-07T01:00:00Z') };
    const order = {
      ...original,
      ...mergeOfficialOrder(original, parse('PAYMENT_DUE_STORED_ORDER')),
    };
    const json = buildLifecycleJson('PAYMENT_RECEIVED');
    delete json.orderDetail.orderHeader.d.orderPlacedDate;
    const next = mergeOfficialOrder(order, parseOrderData(json, ''));
    expect(next.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'orderDate',
          sourceValue: '2026-09-07',
          officialValue: '2026-09-08',
        }),
      ])
    );
  });
  test.each([true, false, {}, '1e3', -1, Number.MAX_SAFE_INTEGER + 1])(
    '非法数量 %j 不覆盖商品',
    quantity => {
      const json = buildLifecycleJson('PAYMENT_DUE_STORED_ORDER');
      json.orderDetail.orderItems['orderItem-11'].orderItemDetails.d.quantity = quantity;
      const data = parseOrderData(json, '');
      expect(data.productsComplete).toBe(false);
      expect(data.products[0].quantity).toBeNull();
      expect(mergeOfficialOrder(sourceOrder(), data)).not.toHaveProperty('products');
    }
  );
  test.each([
    ['PAYMENT_DUE_STORED_ORDER', 'payment_due', 'unpaid', 'not_ready', true],
    ['PAYMENT_RECEIVED', 'payment_received', 'paid', 'not_ready', false],
    ['PROCESSING', 'processing', 'paid', 'not_ready', false],
    ['READY_FOR_PICKUP', 'ready_for_pickup', 'paid', 'ready_for_pickup', false],
    ['PICKED_UP', 'picked_up', 'paid', 'picked_up', false],
    ['PAYMENT_EXPIRED_STORED_ORDER', 'payment_expired', 'unpaid', 'not_applicable', false],
  ])('%s 确定映射并按最新付款规则刷新', (raw, status, paymentStatus, pickupStatus, auto) => {
    const data = parse(raw);
    const merged = { ...sourceOrder(), ...mergeOfficialOrder(sourceOrder(), data) };
    expect(data).toMatchObject({
      orderStatus: status,
      paymentStatus,
      pickupStatus,
      officialRawStatus: raw,
    });
    expect(data.officialOrderCreatedAt).toBeNull();
    expect(isAutoRefreshEligible(merged)).toBe(auto);
    if (paymentStatus === 'paid' || !auto) expect(isPaymentBlocked(merged)).toBe(true);
    expect(data).not.toHaveProperty('rawJson');
    expect(data.products[0]).not.toHaveProperty('deliveryDate');
  });

  test('准确 Epoch 优先于创建时间，付款后金额与截止保留且冲突不因重复刷新消失', () => {
    let order = sourceOrder();
    order = { ...order, ...mergeOfficialOrder(order, parse('PAYMENT_DUE_STORED_ORDER')) };
    const expiresAt = order.officialPaymentExpiresAt;
    expect(expiresAt.getTime()).toBe(1788871260 * 1000);
    expect(order.officialOrderAmount).toBe(8999);
    expect(order.paymentMethod).toBe('支付宝');
    expect(order.products).toEqual([expect.objectContaining({ model: 'MODEL-1', quantity: 1 })]);
    expect(order.sourceSnapshot.products[0].quantity).toBe(2);
    const conflicts = order.validationIssues;
    for (const stage of ['PAYMENT_RECEIVED', 'PROCESSING', 'READY_FOR_PICKUP', 'PICKED_UP']) {
      order = { ...order, ...mergeOfficialOrder(order, parse(stage)) };
      expect(order.officialOrderAmount).toBe(8999);
      expect(order.officialOrderAmountCurrency).toBe('CNY');
      expect(order.officialPaymentExpiresAt).toEqual(expiresAt);
      expect(order.products).toHaveLength(1);
      expect(order.products[0].model).toBe('MODEL-1');
      expect(order.validationIssues).toEqual(conflicts);
    }
    expect(
      getOfficialDeadline({ ...order, officialOrderCreatedAt: new Date('2030-01-01T00:00:00Z') })
    ).toEqual(expiresAt);
    const serialized = serializeTask({ toJSON: () => ({ order, processingStatus: 'processing' }) });
    expect(serialized).toMatchObject({
      processingStatus: 'processing',
      officialPaymentConfirmed: true,
      officialPaymentDiscrepancy: true,
    });
  });

  test.each([undefined, null, '格式错误'])(
    '金额 %s 与缺失、空值、解析失败分别诊断并保留最后有效值',
    value => {
      const json = buildLifecycleJson('PAYMENT_DUE_STORED_ORDER');
      if (value === undefined) delete json.orderDetail.orderHeader.payNow.d.totalAmount;
      else json.orderDetail.orderHeader.payNow.d.totalAmount = value;
      const data = parseOrderData(json, '<html></html>');
      expect(data.officialFieldDiagnostics.amount).toBe(
        value === undefined ? 'missing' : value === null ? 'null' : 'invalid'
      );
      const old = { ...sourceOrder(), officialOrderAmount: 99, officialOrderAmountCurrency: 'CNY' };
      expect({ ...old, ...mergeOfficialOrder(old, data) }.officialOrderAmount).toBe(99);
    }
  );

  test('官网纠正金额和取消零数量生效，导入快照不改变', () => {
    const json = buildLifecycleJson('PAYMENT_DUE_STORED_ORDER');
    json.orderDetail.orderHeader.payNow.d.totalAmount = '¥0.00';
    json.orderDetail.orderItems['orderItem-11'].orderItemDetails.d.quantity = 0;
    const update = mergeOfficialOrder(sourceOrder(), parseOrderData(json, ''));
    expect(update.officialOrderAmount).toBe(0);
    expect(update.products[0].quantity).toBe(0);
    expect(update.sourceSnapshot.products[0].quantity).toBe(2);
    expect(update.validationIssues.some(issue => issue.field === 'products.0.quantity')).toBe(true);
  });

  test('混合阶段逐项保存，不以第一项已取货判定整单完成', () => {
    const json = buildLifecycleJson('PICKED_UP');
    const second = buildLifecycleJson('PAYMENT_DUE_STORED_ORDER').orderDetail.orderItems[
      'orderItem-11'
    ];
    json.orderDetail.orderItems['orderItem-2'] = second;
    const data = parseOrderData(json, '已取货');
    expect(data).toMatchObject({
      orderStatus: 'unknown',
      officialStatusNeedsReview: true,
      officialAllItemsTerminal: false,
    });
    expect(data.products).toHaveLength(2);
    const order = { ...sourceOrder(), ...mergeOfficialOrder(sourceOrder(), data) };
    expect(isPaymentBlocked(order)).toBe(true);
    expect(
      isAutoRefreshEligible(order, new Date(order.officialPaymentExpiresAt.getTime() - 60_000))
    ).toBe(true);
    expect(isAutoRefreshEligible(order, order.officialPaymentExpiresAt)).toBe(false);
    second.orderItemStatusTracker.d.currentStatus = 'PAYMENT_EXPIRED_STORED_ORDER';
    const terminal = parseOrderData(json, '');
    expect(terminal.officialAllItemsTerminal).toBe(true);
    expect(isAutoRefreshEligible({ ...order, ...mergeOfficialOrder(order, terminal) })).toBe(false);
  });

  test('不同已付款阶段全部明确已付时停止刷新', () => {
    const items = ['PROCESSING', 'PICKED_UP'].map(status =>
      Object.values(buildLifecycleJson(status).orderDetail.orderItems).find(
        item => item.orderItemDetails
      )
    );
    expect(summarizeLifecycle(items)).toMatchObject({
      orderStatus: 'unknown',
      paymentStatus: 'paid',
      officialStatusNeedsReview: true,
    });
  });

  test('未知枚举保持原值，正文已取货和 possibleStatuses 不覆盖', () => {
    const data = parseOrderData(
      buildLifecycleJson('NEW_APPLE_ENUM'),
      '<main>已取货 已收到付款</main>'
    );
    expect(data).toMatchObject({
      officialRawStatus: 'NEW_APPLE_ENUM',
      orderStatus: 'unknown',
      officialStatusNeedsReview: true,
    });
    expect(data.paymentStatus).not.toBe('paid');
  });

  test('init_data 优先，损坏时拒绝借其他脚本替代', () => {
    const valid = JSON.stringify(buildLifecycleJson('PICKED_UP'));
    expect(
      extractOrderJson(`<script>${valid}</script>${buildLifecycleHtml('PAYMENT_RECEIVED')}`)
        .orderDetail.orderItems['orderItem-11'].orderItemStatusTracker.d.currentStatus
    ).toBe('PAYMENT_RECEIVED');
    expect(
      extractOrderJson(`<script id="init_data">{broken</script><script>${valid}</script>`)
    ).toBeNull();
  });

  test.each(['¥1.234', '¥-1', '¥1,23', '¥10000000000', '¥Infinity', 100])(
    '拒绝非法金额 %s',
    value => expect(parseOfficialMoney(value)).toBeNull()
  );
  test.each([null, '', 'bad', 1788871260000])('拒绝无效 Epoch %s，不误把毫秒当秒', value => {
    const json = buildLifecycleJson('PAYMENT_DUE_STORED_ORDER');
    json.orderDetail.orderItems['orderItem-11'].orderItemDetails.d.paymentTimeToExpiryEpoch = value;
    expect(parseOrderData(json, '').officialPaymentExpiresAt).toBeNull();
  });

  test('取消缺少支付证据保留已付款；官网商品缺失型号不凭动态键制造身份', () => {
    const order = { ...sourceOrder(), paymentStatus: 'paid' };
    const data = parse('CANCELLED');
    expect({ ...order, ...mergeOfficialOrder(order, data) }.paymentStatus).toBe('paid');
    expect(JSON.stringify(mergeOfficialOrder(order, data).products)).not.toContain('orderItem-');
  });

  test('不完整官网商品不覆盖已有列表；缺失付款方式保留已有冲突', () => {
    let order = {
      ...sourceOrder(),
      ...mergeOfficialOrder(sourceOrder(), parse('PAYMENT_DUE_STORED_ORDER')),
    };
    const json = buildLifecycleJson('PAYMENT_RECEIVED');
    delete json.orderDetail.billingInfo;
    json.orderDetail.orderItems['orderItem-11'].orderItemDetails.d.quantity = null;
    const result = mergeOfficialOrder(order, parseOrderData(json, ''));
    expect(result).not.toHaveProperty('products');
    expect(result.officialStatusNeedsReview).toBe(true);
    expect(result.validationIssues.some(issue => issue.field === 'paymentMethod')).toBe(true);
  });

  test('DTO 不暴露图片、动作链接、来源快照或错单内容', () => {
    expect(safeText({ secret: 'secret' })).toBeNull();
    expect(safeText('https://example.com/token')).toBeNull();
    const serialized = serializePublicProducts([
      {
        name: '测试',
        quantity: 1,
        image: 'https://example.com/token',
        pickupInstructionURL: 'secret',
        rawJson: { secret: true },
      },
    ]);
    expect(serialized).toEqual([{ name: '测试', quantity: 1 }]);
    expect(
      serializeValidationIssues([
        { type: 'order_identity', sourceValue: 'W9999999999', officialValue: 'secret' },
      ])[0]
    ).not.toHaveProperty('officialValue');
    expect(serializeOfficialFields({ sourceSnapshot: { secret: 'secret' } })).not.toHaveProperty(
      'source_snapshot'
    );
  });

  test('冲突 DTO 保留非敏感对照和诊断白名单，忽略任意字段', () => {
    const issues = serializeValidationIssues([
      {
        type: 'source_conflict',
        field: 'paymentMethod',
        sourceValue: '银行卡',
        officialValue: '支付宝',
        resolution: 'official',
        message: '官网优先',
      },
      {
        type: 'source_conflict',
        field: 'products.0.quantity',
        sourceValue: 2,
        officialValue: 0,
        resolution: 'official',
      },
      {
        type: 'source_conflict',
        field: 'password',
        sourceValue: 'secret',
        officialValue: 'secret',
      },
    ]);
    expect(issues[0]).toMatchObject({
      field: 'paymentMethod',
      sourceValue: '银行卡',
      officialValue: '支付宝',
      resolution: 'official',
    });
    expect(issues[1]).toMatchObject({ sourceValue: 2, officialValue: 0 });
    expect(JSON.stringify(issues)).not.toContain('secret');
    expect(
      serializeOfficialFields({
        officialFieldDiagnostics: {
          amount: 'missing',
          password: 'secret',
          paymentMethod: 'invalid',
          statusDescription: 'secret',
        },
      }).official_field_diagnostics
    ).toEqual({ amount: 'missing', paymentMethod: 'invalid' });
  });
});
