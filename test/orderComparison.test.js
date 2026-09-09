jest.mock('../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn() }));
const {
  equivalentOrderValue,
  revalidateExpressionConflicts,
} = require('../src/services/crawler/orderComparison');
const { mergeOfficialOrder } = require('../src/services/crawler/officialOrderData');
const { revalidateOrders } = require('../scripts/revalidateOrderConflicts');

const sourceName = 'iPhone 17 Pro Max 深蓝色 256G';
const officialName = 'iPhone\u00a017\u00a0Pro\u00a0Max 256GB 深蓝色';
const product = (name, model = '', quantity = 2) => ({ name, model, quantity });
const conflict = (field, sourceValue, officialValue) => ({
  type: 'source_conflict',
  field,
  sourceValue,
  officialValue,
  resolution: 'official',
});
function merge(products, incoming, paymentMethod = '微信', officialPaymentMethod = 'WECHAT') {
  return mergeOfficialOrder(
    { products, paymentMethod },
    {
      products: incoming,
      officialPaymentMethod,
      orderStatus: 'payment_expired',
    }
  );
}

describe('来源表达语义比较', () => {
  test.each([
    ['微信', 'WECHAT'],
    ['微信支付', ' weChat '],
    ['ＷＥＣＨＡＴ', '微信'],
    ['支付宝', 'ALIPAY'],
    [' 支付宝 ', 'aliPay'],
    ['银行卡', '银行卡'],
  ])('付款方式 %s 与 %s 等价', (source, official) => {
    expect(equivalentOrderValue('paymentMethod', source, official)).toBe(true);
    expect(merge([], [], source, official).validationIssues).toEqual([]);
  });
  test.each([
    ['微信', 'ALIPAY'],
    ['花呗', 'ALIPAY'],
    ['支付宝花呗', '支付宝'],
    ['银行卡', 'WECHAT'],
    ['未知', 'ALIPAY'],
  ])('付款方式 %s 与 %s 不合并', (source, official) => {
    expect(merge([], [], source, official).validationIssues).toEqual([
      expect.objectContaining({ field: 'paymentMethod' }),
    ]);
  });
  test.each([
    [sourceName, officialName],
    ['iPhone 17 Pro 星宇橙色 256G', 'iPhone 17 Pro 256GB 星宇橙色'],
    ['iPhone 17 Pro Max 银色 1T', 'iPhone 17 Pro Max 1TB 银色'],
    ['ｉＰｈｏｎｅ １７ Ｐｒｏ 深蓝色 ２５６Ｇ', 'iPhone 17 Pro 256GB 深蓝色'],
  ])('名称 %s 与 %s 等价且保留原文', (source, official) => {
    const next = merge([product(source, 'SKU-1')], [product(official)]);
    expect(next.validationIssues).toEqual([]);
    expect(next.validationStatus).toBe('valid');
    expect(next.sourceSnapshot.products[0].name).toBe(source);
    expect(next.products[0].name).toBe(official);
    expect(next.officialProducts[0].name).toBe(official);
  });
  test.each([
    'iPhone 17 Pro Max 512GB 深蓝色',
    'iPhone 17 Pro 256GB 深蓝色',
    'iPhone 16 Pro Max 256GB 深蓝色',
    'iPhone 17 Pro Max 256GB 银色',
    'iPhone 17 Pro Max 256GB 深蓝色 官换',
    'iPhone 17 Pro Max 256GB',
    'iPhone 17 Pro Max 8GB RAM 256GB 深蓝色',
  ])('真实商品差异仍告警：%s', name => {
    expect(merge([product(sourceName)], [product(name)]).validationIssues).toEqual([
      expect.objectContaining({ field: 'products.0.name' }),
    ]);
  });
  test.each([
    ['iPhone 17 Pro Max 银色 1T', 'iPhone 17 Pro Max 1024GB 银色'],
    ['未知商品 蓝色 256G', '未知商品 256GB 蓝色'],
    ['iPhone 17 Pro Max 深蓝色 256G 附赠', 'iPhone 17 Pro Max 256GB 深蓝色 附赠'],
  ])('不猜测未知表达或跨单位换算', (left, right) => {
    expect(equivalentOrderValue('name', left, right)).toBe(false);
  });
  test('等价名称不掩盖 SKU 和数量冲突，官网零数量有效', () => {
    const next = merge([product(sourceName, 'SKU-A')], [product(officialName, 'SKU-B', 0)]);
    expect(next.validationIssues.map(issue => issue.field)).toEqual([
      'products.0.model',
      'products.0.quantity',
    ]);
    expect(next.products[0].quantity).toBe(0);
  });
  test('多商品顺序改变且官网缺 SKU，按语义唯一匹配', () => {
    const next = merge(
      [product(sourceName, 'SKU-A'), product('iPhone 17 Pro 星宇橙色 256G', 'SKU-B', 1)],
      [product('iPhone 17 Pro 256GB 星宇橙色', '', 1), product(officialName)]
    );
    expect(next.validationIssues).toEqual([]);
    expect(next.products.map(item => item.model)).toEqual(['SKU-B', 'SKU-A']);
  });
  test('全局 SKU 优先，名称相同的缺 SKU 项不能抢占精确匹配', () => {
    const next = merge(
      [product(sourceName, 'SKU-A', 1), product(sourceName, 'SKU-B', 2)],
      [product(officialName, '', 2), product(officialName, 'SKU-A', 1)]
    );
    expect(next.validationIssues).toEqual([]);
    expect(next.products.map(item => item.model)).toEqual(['SKU-B', 'SKU-A']);
  });
  test('多个相同名称候选不按顺序猜测或重复使用', () => {
    const next = merge(
      [product(sourceName, 'SKU-A'), product(sourceName, 'SKU-B')],
      [product(officialName), product(officialName)]
    );
    expect(next.validationIssues.map(issue => issue.field)).toEqual(['products.0', 'products.1']);
    expect(next.products.every(item => !item.model)).toBe(true);
  });
  test('同一候选被两个官网项目竞争时保持未匹配', () => {
    const next = merge(
      [product(sourceName, 'SKU-A')],
      [product(officialName), product(officialName)]
    );
    expect(next.validationIssues.map(issue => issue.field)).toEqual([
      'products.0',
      'products.1',
      'products',
    ]);
  });
  test('同 SKU 多候选以名称消歧', () => {
    const next = merge(
      [product(sourceName, 'SKU-A'), product('配件', 'SKU-A')],
      [product('配件', 'SKU-A'), product(officialName, 'SKU-A')]
    );
    expect(next.validationIssues).toEqual([]);
  });
});

describe('历史误报重校验', () => {
  const expressionIssues = () => [
    conflict('paymentMethod', '微信', 'WECHAT'),
    conflict('products.0.name', sourceName, officialName),
  ];
  test('两笔真实表达的历史快照可消除误报且不改生命周期和时间', () => {
    const order = {
      validationIssues: expressionIssues(),
      status: 'payment_expired',
      lastCrawledAt: new Date(),
      anomalyDetectedAt: new Date(),
    };
    const original = structuredClone(order);
    const patch = revalidateExpressionConflicts(order);
    expect(patch).toEqual({
      validationIssues: [],
      validationStatus: 'valid',
      anomalyDetectedAt: null,
    });
    expect(order).toEqual(original);
    expect(revalidateExpressionConflicts({ ...order, ...patch })).toBeNull();
  });
  test('保留所有其他异常、真实差异和异常发生时间', () => {
    const keep = [
      { type: 'order_identity' },
      { type: 'status_review' },
      { type: 'parse_field' },
      conflict('products.0.model', 'A', 'B'),
      conflict('products.0.quantity', 2, 0),
      conflict('paymentMethod', '花呗', 'ALIPAY'),
      conflict('products.1.name', sourceName, '其他商品'),
      conflict('products.0', '未匹配', '未匹配'),
      conflict('products.0.name', null, null),
      conflict('products.0.name', '', ''),
      conflict('pickupStore', '门店', '门店'),
    ];
    const date = new Date();
    expect(
      revalidateExpressionConflicts({
        validationIssues: [...expressionIssues(), ...keep],
        anomalyDetectedAt: date,
      })
    ).toEqual({ validationIssues: keep, validationStatus: 'abnormal', anomalyDetectedAt: date });
  });
  test('缺少问题或没有等价项时不产生写入', () => {
    expect(revalidateExpressionConflicts({})).toBeNull();
    expect(revalidateExpressionConflicts({ validationIssues: [] })).toBeNull();
  });
  function database() {
    const row = {
      id: 1,
      orderNumber: 'W1234567890',
      validationIssues: expressionIssues(),
      update: jest.fn(),
    };
    const transaction = { LOCK: { UPDATE: 'UPDATE' } };
    const models = {
      sequelize: { transaction: jest.fn(callback => callback(transaction)) },
      Order: { findAll: jest.fn().mockResolvedValue([row]) },
    };
    return { row, transaction, models };
  }
  test('默认预览不写数据库', async () => {
    const { row, models } = database();
    await expect(revalidateOrders(models, [row.orderNumber])).resolves.toEqual([
      { orderNumber: row.orderNumber, changed: true, executed: false, remainingIssues: 0 },
    ]);
    expect(row.update).not.toHaveBeenCalled();
    expect(models.Order.findAll.mock.calls[0][0]).not.toHaveProperty('lock');
  });
  test('执行使用行锁、同一事务和精确字段，保留更新时间', async () => {
    const { row, transaction, models } = database();
    await revalidateOrders(models, [row.orderNumber], true);
    expect(models.Order.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ lock: 'UPDATE', transaction })
    );
    expect(row.update).toHaveBeenCalledWith(expect.any(Object), {
      transaction,
      fields: ['validationIssues', 'validationStatus', 'anomalyDetectedAt'],
      silent: true,
    });
  });
  test.each([[], ['invalid'], Array(101).fill('W1234567890')].map(numbers => [numbers]))(
    '非法范围在查询前拒绝',
    async numbers => {
      const { models } = database();
      await expect(revalidateOrders(models, numbers)).rejects.toThrow();
      expect(models.sequelize.transaction).not.toHaveBeenCalled();
    }
  );
  test('指定订单缺失时禁止部分更新', async () => {
    const { row, models } = database();
    await expect(revalidateOrders(models, [row.orderNumber, 'W1234567891'], true)).rejects.toThrow(
      '部分订单不存在'
    );
    expect(row.update).not.toHaveBeenCalled();
  });
  test('更新失败向事务传播错误以触发回滚', async () => {
    const { row, models } = database();
    row.update.mockRejectedValue(new Error('write failed'));
    await expect(revalidateOrders(models, [row.orderNumber], true)).rejects.toThrow('write failed');
  });
});
