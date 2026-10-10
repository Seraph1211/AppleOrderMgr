const { parseOrderMailLifecycle } = require('../src/services/orderMailLifecycleParser');
const { aggregateOrderLifecycle } = require('../src/services/orderMailLifecycleService');

const product = 'iPhone 18 Pro Max 1TB 冰川蓝色';
const order = { orderNumber: 'W7999999999', products: [{ name: product, quantity: 2 }] };
const header = ['我们已收到您的退货申请。', '订单号 W7999999999', '退货号：RS799999999'];
const section = ['要退回的商品', product, 'RMB 16,499.00', '数量 1', '总计', 'RMB 16,499.00'];

function parse(lines, subject = '我们已经收到您的退货申请。') {
  return parseOrderMailLifecycle({ subject, text: [...header, ...lines].join('\n') });
}

function event(parsed, number = 1) {
  return {
    ...parsed,
    id: `event-${number}`,
    messageId: `mail-${number}`,
    source: 'parser',
    revision: 1,
    message: { orderNumber: order.orderNumber, emailDate: new Date('2026-10-10T00:00:00Z') },
  };
}

describe('独立邮件退货解析边界', () => {
  test('同一商品段重复引用不翻倍；退货段外数量不计入', () => {
    const parsed = parse([...section, ...section, '原订单商品', product, '数量 2']);
    expect(parsed.needsReview).toBe(false);
    expect(parsed.evidence.returnRequest.quantity).toBe(1);
    expect(aggregateOrderLifecycle(order, [event(parsed)]).orderStatus).toBe(
      'partially_return_requested'
    );
  });

  test('两个商品行第二个缺数量，不允许悄悄保留第一件通过', () => {
    const parsed = parse([
      '要退回的商品',
      product,
      'RMB 16,499.00',
      '数量 1',
      product,
      'RMB 16,499.00',
      '总计',
      'RMB 32,998.00',
    ]);
    expect(parsed.needsReview).toBe(true);
    expect(parsed.orderStatus).toBeNull();
  });

  test('两个商品行第一个缺数量，不允许只识别第二件通过', () => {
    const parsed = parse([
      '要退回的商品',
      product,
      'RMB 16,499.00',
      product,
      'RMB 16,499.00',
      '数量 1',
      '总计',
      'RMB 32,998.00',
    ]);
    expect(parsed.needsReview).toBe(true);
    expect(parsed.orderStatus).toBeNull();
  });

  test('不同退货号累计超出总数量后不得推断全退', () => {
    const first = parse(section);
    const second = parse([...section.slice(0, 3), '数量 2', '总计']);
    second.evidence.returnRequest.requestNumber = 'RS799999998';
    const combined = aggregateOrderLifecycle(order, [event(first), event(second, 2)]);
    expect(combined.needsReview).toBe(true);
    expect(combined.orderStatus).not.toBe('return_requested');
  });

  test('多个订单号不能仅凭退货标题/数量通过', () => {
    const parsed = parse([...section, '原订单号 W7888888888']);
    expect(parsed.needsReview).toBe(true);
    expect(parsed.orderStatus).toBeNull();
  });

  test('正文缺少确认事件不能通过', () => {
    const parsed = parseOrderMailLifecycle({
      subject: '我们已经收到您的退货申请。',
      text: [...header.slice(1), ...section].join('\n'),
    });
    expect(parsed.needsReview).toBe(true);
    expect(parsed.orderStatus).toBeNull();
  });

  test.each(['Fwd: 个人设置辅导，帮你上手新 iPhone。', 'Re: 个人设置辅导，帮你上手新 iPhone。'])(
    '既有辅导精确标题规则不被%s放宽',
    subject => {
      const parsed = parseOrderMailLifecycle({ subject, text: '订单号 W7999999999' });
      expect(parsed.templateType).toBe('unknown');
      expect(parsed.orderStatus).toBeNull();
    }
  );
});
