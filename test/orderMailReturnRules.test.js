const { parseOrderMailLifecycle } = require('../src/services/orderMailLifecycleParser');
const { aggregateOrderLifecycle } = require('../src/services/orderMailLifecycleService');
const name = 'iPhone 18 Pro Max 1TB 冰川蓝色';
const order = {
  orderNumber: 'W1234567890',
  emailOrderStatus: 'picked_up',
  products: [{ name, quantity: 2 }],
};
function mail(number = 'TEST1234567', quantities = [1]) {
  return {
    subject: '我们已经收到您的退货申请。',
    text: [
      '我们已收到您的退货申请',
      `你的退货号是：${number}。`,
      '订单号:',
      order.orderNumber,
      '退货号',
      `: ${number}`,
      `在包裹外侧写上你的退货编号 ${number}。`,
      '要退回的商品',
      ...quantities.flatMap(quantity => [
        name,
        'RMB 16,499.00',
        `数量 ${quantity}`,
        '(RMB 16,499.00)',
      ]),
      '总计',
      '(RMB 32,998.00)',
      '退货号：',
      '银行账户信息',
    ].join('\n'),
  };
}
function event(id, number, quantities) {
  return {
    ...parseOrderMailLifecycle(mail(number, quantities)),
    messageId: id,
    id,
    source: 'parser',
    revision: 1,
    message: { orderNumber: order.orderNumber, emailDate: new Date('2026-10-10') },
  };
}
describe('退货邮件设备数量与跨邮件幂等', () => {
  test('真实模板结构：两个独立数量1行合计2', () => {
    const parsed = parseOrderMailLifecycle(mail('TEST1234567', [1, 1]));
    expect(parsed).toMatchObject({
      templateType: 'return_requested',
      needsReview: false,
      paymentStatus: null,
      pickupInfo: null,
      evidence: { returnRequest: { quantity: 2 } },
    });
    expect(aggregateOrderLifecycle(order, [event('a', 'TEST1234567', [1, 1])]).orderStatus).toBe(
      'return_requested'
    );
  });
  test('一台部分、跨日不同申请累计两台；乱序一致', () => {
    const a = event('a', 'TEST1234567', [1]);
    const b = event('b', 'TEST1234568', [1]);
    expect(aggregateOrderLifecycle(order, [a]).orderStatus).toBe('partially_return_requested');
    expect(aggregateOrderLifecycle(order, [a, b]).orderStatus).toBe('return_requested');
    expect(aggregateOrderLifecycle(order, [b, a]).orderStatus).toBe('return_requested');
  });
  test('同号多消息、相同消息多次回放仅一次', () => {
    const a = event('a', 'TEST1234567', [1]);
    const b = event('b', 'TEST1234567', [1]);
    expect(aggregateOrderLifecycle(order, [a, a, b]).orderStatus).toBe(
      'partially_return_requested'
    );
  });
  test('转发重复段落不重复累计', () => {
    const parsed = mail('TEST1234567', [1]);
    parsed.subject = 'Fwd: ' + parsed.subject;
    parsed.text += '\n' + parsed.text;
    expect(parseOrderMailLifecycle(parsed).evidence.returnRequest.quantity).toBe(1);
  });
  test.each(['数量 0', '数量 -1', '数量 1.5', '数量 不详'])('数量无效%s不推定', invalid => {
    const parsed = mail();
    parsed.text = parsed.text.replace('数量 1', invalid);
    expect(parseOrderMailLifecycle(parsed).needsReview).toBe(true);
  });
  test('缺退货号不推定', () => {
    const parsed = mail();
    parsed.text = parsed.text.replaceAll('TEST1234567', '');
    expect(parseOrderMailLifecycle(parsed).needsReview).toBe(true);
  });
  test('同号冲突、超量和取消冲突保留核对', () => {
    expect(
      aggregateOrderLifecycle(order, [
        event('a', 'TEST1234567', [1]),
        event('b', 'TEST1234567', [2]),
      ]).reviewReasons
    ).toContain('RETURN_REQUEST_CONFLICT');
    expect(
      aggregateOrderLifecycle(order, [
        event('a', 'TEST1234567', [2]),
        event('b', 'TEST1234568', [1]),
      ]).reviewReasons
    ).toContain('RETURN_QUANTITY_EXCEEDS_ORDER');
    expect(
      aggregateOrderLifecycle({ ...order, emailOrderStatus: 'cancelled' }, [
        event('a', 'TEST1234567', [2]),
      ]).reviewReasons
    ).toContain('RETURN_TERMINAL_CONFLICT');
  });
  test('逐商品范围保护', () => {
    const e = event('a', 'TEST1234567', [2]);
    const mixed = {
      ...order,
      products: [
        { name, quantity: 1 },
        { name: 'iPhone 18 Pro Max 512GB 银色', quantity: 1 },
      ],
    };
    expect(aggregateOrderLifecycle(mixed, [e]).reviewReasons).toContain(
      'RETURN_PRODUCT_SCOPE_MISMATCH'
    );
  });
});
