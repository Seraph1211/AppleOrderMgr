const {
  calculateCatalogAmount,
  getCatalogUnitPrice,
  PRICE_VERSION,
} = require('../src/utils/orderCatalogPricingV1');
const { serializeOrderPricingFields } = require('../src/utils/orderSerialization');

describe('已确认的 iPhone 18 裸机价格映射', () => {
  test.each([
    ['Pro', '256GB', 9999],
    ['Pro', '512GB', 11999],
    ['Pro', '1TB', 15499],
    ['Pro', '2TB', 20499],
    ['Pro Max', '256GB', 10999],
    ['Pro Max', '512GB', 12999],
    ['Pro Max', '1TB', 16499],
    ['Pro Max', '2TB', 21499],
  ])('%s %s 单价与双台金额', (model, size, price) => {
    for (const color of ['勃艮第酒红色', '冰川蓝色', '银色', '黑色']) {
      const product = { name: `iPhone 18 ${model} ${size} ${color}`, quantity: 2 };
      expect(getCatalogUnitPrice(product)).toBe(price);
      expect(calculateCatalogAmount([product])).toEqual({
        orderAmount: (price * 2).toFixed(2),
        orderAmountPriceVersion: PRICE_VERSION,
      });
    }
  });
  test.each([
    ['iPhone 18 ProMax 黑色 256G', 10999],
    ['ＩＰＨＯＮＥ １８ Ｐｒｏ ５１２ＧＢ 银色', 11999],
    ['iPhone\u00a018\u00a0Pro Max 冰川蓝色 1 T', 16499],
    ['iPhone 18 Pro 1024GB', 15499],
    ['iPhone 18 Pro Max 2048GB burgundy', 21499],
  ])('来源名称兼容 %s', (name, price) => {
    expect(getCatalogUnitPrice({ name, quantity: 1 })).toBe(price);
  });
  test.each([
    'iPhone 17 Pro 256GB 黑色',
    'iPhone 18 256GB',
    'iPhone 18 Pro Max 128GB',
    'iPhone 18 Pro 1256GB',
    'iPhone 18 Pro 1.256GB',
    'iPhone 18 Pro 256GB 手机壳',
    'iPhone 18 Pro Max 256GB + AppleCare+',
    'iPhone 18 Pro 256GB 512GB',
    'iPhone 18 Pro Max',
    'iPhone 18 Pro Ultra 256GB',
    'MJY64CH/A',
  ])('未知或非裸机不猜价 %s', name => {
    expect(calculateCatalogAmount([{ name, quantity: 1 }]).orderAmount).toBeNull();
  });
  test.each([null, undefined, '', true, -1, 1.5, '1.5', '1e2', NaN, Infinity, 999999999999])(
    '非法数量 %s',
    quantity => {
      expect(
        calculateCatalogAmount([{ name: 'iPhone 18 Pro 256GB', quantity }]).orderAmount
      ).toBeNull();
    }
  );
  test('混合商品汇总，部分未知禁止部分总额，零值不冒充缺失', () => {
    const a = { name: 'iPhone 18 Pro Max 黑色 256G', quantity: '2' };
    const b = { name: 'iPhone 18 Pro 银色 1TB', quantity: 1 };
    expect(calculateCatalogAmount([a, b]).orderAmount).toBe('37497.00');
    expect(calculateCatalogAmount([a, { name: '未知商品', quantity: 0 }]).orderAmount).toBeNull();
    expect(calculateCatalogAmount([{ ...a, quantity: 0 }]).orderAmount).toBe('0.00');
    for (const value of [[], null, {}, [null]])
      expect(calculateCatalogAmount(value).orderAmount).toBeNull();
  });
  test('完整型号可作名称回退；名称和型号冲突不定价；官网金额不回退', () => {
    expect(getCatalogUnitPrice({ model: 'iPhone 18 Pro 256GB' })).toBe(9999);
    expect(
      getCatalogUnitPrice({ model: 'iPhone 18 Pro 256GB', name: 'iPhone 18 Pro Max 256GB' })
    ).toBeNull();
    expect(serializeOrderPricingFields({ officialOrderAmount: '999.00' }).order_amount).toBeNull();
    expect(serializeOrderPricingFields({ orderAmount: 0 }).order_amount).toBe('0.00');
  });
});
