const current = require('../src/utils/orderCatalogPricing');
const legacy = require('../src/utils/orderCatalogPricingV1');
const { CATALOG, fixedCost } = require('../src/services/stockFixedCatalog');
const { parseBoxData } = require('../src/services/stockBoxRules');
const cases = [
  ['MK2M4CH/A', '256GB', '星光白色', 15999],
  ['MK2N4CH/A', '256GB', '夜空色', 15999],
  ['MK2P4CH/A', '512GB', '星光白色', 17999],
  ['MK2Q4CH/A', '512GB', '夜空色', 17999],
  ['MK2T4CH/A', '1TB', '星光白色', 21499],
  ['MK2U4CH/A', '1TB', '夜空色', 21499],
  ['MK2V4CH/A', '2TB', '星光白色', 26499],
  ['MK2W4CH/A', '2TB', '夜空色', 26499],
];
test.each(cases)('Duo精确订单价格及SKU model兼容 %s', (sku, capacity, color, price) => {
  for (const name of [`iPhone Duo ${capacity} ${color}`, `iPhone Duo ${color} ${capacity}`]) {
    expect(current.getCatalogUnitPrice({ name, model: sku })).toBe(price);
    expect(current.calculateCatalogAmount([{ name, model: sku, quantity: 2 }])).toEqual({
      orderAmount: (price * 2).toFixed(2),
      orderAmountPriceVersion: current.PRICE_VERSION,
    });
    expect(legacy.getCatalogUnitPrice({ name })).toBeNull();
  }
});
test('混合机型整单及原版本分派', () => {
  const old = { name: 'iPhone 18 Pro Max 256GB 黑色', quantity: 2 };
  expect(current.calculateCatalogAmount([old])).toEqual(legacy.calculateCatalogAmount([old]));
  expect(
    current.calculateCatalogAmount([old, { name: 'iPhone Duo 1TB 夜空色', quantity: 3 }])
  ).toEqual({ orderAmount: '86495.00', orderAmountPriceVersion: current.PRICE_VERSION });
});
test.each([
  { name: 'iPhone Duo Pro 256GB 星光白色' },
  { name: 'iPhone Duo 256GB 星光白色 手机壳' },
  { name: 'iPhone Duo 256GB 黑色' },
  { name: 'iPhone Duo 256GB 512GB 星光白色' },
  { name: 'iPhone Duo 128GB 星光白色' },
  { name: 'iPhone Duo 256GB 星光白色', model: 'MK2N4CH/A' },
  { name: 'iPhone Duo 256GB 星光白色', model: 'iPhone 18 Pro Max 256GB' },
  { name: 'iPhone Duo 256GB 星光白色', model: 'iPhone Duo 512GB 星光白色' },
  { name: 'iPhone Duo 256GB 星光白色', model: 'MK2M4CH/A', sku: 'MK2N4CH/A' },
])('冲突规格整单待补 %j', product => {
  expect(current.getCatalogUnitPrice(product)).toBeNull();
  expect(current.calculateCatalogAmount([{ ...product, quantity: 1 }]).orderAmount).toBeNull();
});
test.each([-1, 1.5, '2.0', NaN, Infinity, undefined, 9999999999])(
  '拒绝非法数量/溢出 %s',
  quantity => {
    expect(
      current.calculateCatalogAmount([{ name: 'iPhone Duo 256GB 星光白色', quantity }]).orderAmount
    ).toBeNull();
  }
);
test.each(['Pro', 'Air', 'Plus', 'Ultra'])('盒标Duo未知后缀%s不可截断匹配', suffix => {
  const result = parseBoxData({
    content: `MK2M4CH/A iPhone Duo ${suffix} 256GB Star White\nSerial No. AB12CD34EF`,
  })[0];
  expect(result.matchBasis).toBeNull();
  expect(result.reviewReasons).toContain('料号与文字规格冲突');
});
test('固定成本读取Duo自身版本并拒绝无效价格', async () => {
  try {
    const product = { ...CATALOG.find(item => item.skuCode === 'MK2M4CH/A'), id: 'duo' };
    const db = {
      StockOfficialPrice: {
        findOne: jest.fn().mockResolvedValue({ id: 'price', amount: '15999.00' }),
      },
    };
    expect(await fixedCost(db, product)).toMatchObject({
      officialCostAmount: '15999.00',
      costSource: 'fixed_catalog',
    });
    expect(db.StockOfficialPrice.findOne).toHaveBeenCalledWith({
      where: { productId: 'duo', sourceVersion: current.PRICE_VERSION, isActive: true },
      transaction: undefined,
    });
    db.StockOfficialPrice.findOne.mockResolvedValue(null);
    await expect(fixedCost(db, product)).rejects.toMatchObject({ code: 'FIXED_PRICE_UNAVAILABLE' });
  } catch (error) {
    throw new Error('Duo固定价格验证失败', { cause: error });
  }
});

test('name省略颜色时也交叉核对model颜色与SKU', () => {
  expect(
    current.getCatalogUnitPrice({
      name: 'iPhone Duo 256GB',
      model: 'iPhone Duo 256GB 夜空色',
      skuCode: 'MK2M4CH/A',
    })
  ).toBeNull();
  expect(
    current.getCatalogUnitPrice({
      name: 'iPhone Duo 256GB',
      model: 'iPhone Duo 256GB 夜空色',
      skuCode: 'MK2N4CH/A',
    })
  ).toBe(15999);
});
test('SKU大小写和首尾空格归一化但跨字段冲突仍拒绝', () => {
  expect(
    current.getCatalogUnitPrice({ name: 'iPhone 18 Pro Max 256GB 黑色', model: ' mk2m4ch/a ' })
  ).toBeNull();
  expect(
    current.getCatalogUnitPrice({
      name: 'iPhone Duo 256GB 星光白色',
      model: ' mk2m4ch/a ',
      sku: 'MK2M4CH/A',
    })
  ).toBe(15999);
  expect(
    current.getCatalogUnitPrice({
      name: 'iPhone Duo 256GB 星光白色',
      model: ' mk2m4ch/a ',
      sku: 'MK2N4CH/A',
    })
  ).toBeNull();
});
