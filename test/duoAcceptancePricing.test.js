const {
  getCatalogUnitPrice,
  calculateCatalogAmount,
  PRICE_VERSION,
} = require('../src/utils/orderCatalogPricing');
const legacy = require('../src/utils/orderCatalogPricingV1');

describe('iPhone Duo 独立订单定价验收', () => {
  test.each([
    ['256GB', 15999],
    ['512GB', 17999],
    ['1TB', 21499],
    ['2TB', 26499],
  ])('应该正确计算Duo %s 的中英文双台价格', (capacity, price) => {
    for (const color of ['星光白色', '夜空色', 'Star White', 'Night Sky']) {
      const product = { name: `iPhone Duo ${capacity} ${color}`, quantity: '2' };
      expect(getCatalogUnitPrice(product)).toBe(price);
      expect(calculateCatalogAmount([product])).toEqual({
        orderAmount: (price * 2).toFixed(2),
        orderAmountPriceVersion: PRICE_VERSION,
      });
    }
  });

  test('应该完整计算跨机型订单并保留纯旧订单原版本', () => {
    const old = [{ name: 'iPhone 18 Pro 256GB 黑色', quantity: 1 }];
    expect(calculateCatalogAmount(old)).toEqual(legacy.calculateCatalogAmount(old));
    expect(
      calculateCatalogAmount([
        ...old,
        { name: 'iPhone 18 Pro Max 2TB 银色', quantity: 2 },
        { name: 'iPhone Duo 512GB 夜空色', quantity: 3 },
      ])
    ).toEqual({ orderAmount: '106994.00', orderAmountPriceVersion: PRICE_VERSION });
    expect(legacy.getCatalogUnitPrice({ name: 'iPhone Duo 256GB 星光白色' })).toBeNull();
    expect(PRICE_VERSION).not.toBe(legacy.PRICE_VERSION);
  });

  test.each([
    'iPhone Duo 128GB 星光白色',
    'iPhone Duo 256GB 黑色',
    'iPhone Duo 256GB 手机壳',
    'iPhone Duo 256GB + AppleCare+',
    'iPhone Duo 256GB 512GB',
    'iPhone Duo 256GB Star White Night Sky',
    'iPhone Duo Pro 256GB',
    'iPhone Duo 1256GB',
    'iPhone Duo',
    'MK2M4CH/A',
  ])('应该整单拒绝含未知或配件 %s 而不返回部分金额', name => {
    expect(
      calculateCatalogAmount([
        { name: 'iPhone Duo 256GB 星光白色', quantity: 1 },
        { name, quantity: 1 },
      ]).orderAmount
    ).toBeNull();
  });

  test.each([null, undefined, '', true, -1, 1.5, '1.5', '1e2', NaN, Infinity, 999999999999])(
    '应该整单拒绝非法数量 %s',
    quantity => {
      expect(
        calculateCatalogAmount([
          { name: 'iPhone Duo 256GB 星光白色', quantity: 1 },
          { name: 'iPhone Duo 512GB 夜空色', quantity },
        ]).orderAmount
      ).toBeNull();
    }
  );

  test('应该保留零数量行为并拒绝跨型号和SKU冲突', () => {
    expect(
      calculateCatalogAmount([{ name: 'iPhone Duo 256GB 星光白色', quantity: 0 }]).orderAmount
    ).toBe('0.00');
    expect(
      getCatalogUnitPrice({ name: 'iPhone Duo 256GB 星光白色', model: 'iPhone 18 Pro 256GB' })
    ).toBeNull();
    expect(
      getCatalogUnitPrice({ name: 'iPhone Duo 256GB 星光白色', skuCode: 'MK2W4CH/A' })
    ).toBeNull();
  });

  test.each([
    ['iPhone Duo 256GB 星光白色', 'MK2M4CH/A', 15999],
    ['iPhone Duo 星光白色 256GB', 'MK2M4CH/A', 15999],
    ['iPhone Duo Night Sky 2TB', 'MK2W4CH/A', 26499],
    ['iPhone Duo 256GB 星光白色', 'MK2N4CH/A', null],
    ['iPhone Duo 256GB 星光白色', 'MJY64CH/A', null],
  ])('应该核对名称 %s 与来源model料号 %s', (name, model, amount) => {
    expect(getCatalogUnitPrice({ name, model })).toBe(amount);
  });

  test.each([
    { name: 'iPhone Duo 256GB', model: 'iPhone Duo 256GB 夜空色', skuCode: 'MK2M4CH/A' },
    { name: 'iPhone 18 Pro Max 256GB 黑色', model: 'mk2m4ch/a' },
    { name: 'iPhone 18 Pro Max 256GB 黑色', model: '  MK2M4CH/A  ' },
    { name: 'iPhone Duo 256GB', model: 'iPhone Duo 256GB 星光白色', skuCode: 'MK2N4CH/A' },
  ])('应该拒绝所有名称、型号颜色和规范化SKU交叉冲突 %#', product => {
    expect(getCatalogUnitPrice(product)).toBeNull();
  });
});
