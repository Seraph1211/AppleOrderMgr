const {
  moneyToCents,
  normalizeDuoSource,
  createSourceVersion,
  validateMarkup,
  calculateRetailPrice,
  mergeDuoItems,
  publicDuoItem,
} = require('../src/services/duoQuotePricingCore');

function batch() {
  const sourceUpdatedAt = new Date(Date.now() - 60000);
  return {
    sourceUpdatedAt,
    lastCheckedAt: new Date(),
    items: [256, 512, 1024, 2048].flatMap(storageGb =>
      ['星光白色', '夜空色'].map(color => ({
        productModel: 'Duo',
        storageGb,
        color,
        sourceUpdatedAt,
        wholesalePrice: '16000.25',
        officialPrice: '15999.00',
      }))
    ),
  };
}

test.each([null, undefined, true, false, '', ' ', '1e2', '1.001', ' 50 ', [], {}, NaN, Infinity])(
  '金额拒绝隐式转换 %p',
  value => expect(() => moneyToCents(value)).toThrow()
);
test.each([
  [0.29, 29],
  ['-50.25', -5025],
  ['0', 0],
  [99999999.99, 9999999999],
])('金额 %p 以整数分运算', (value, cents) => expect(moneyToCents(value)).toBe(cents));

test('加价和零售价边界、负加价、缺价精度', () => {
  expect(validateMarkup('-100000.00')).toBe(-100000);
  expect(() => validateMarkup(100000.01)).toThrow();
  expect(calculateRetailPrice(100.2, -50.15)).toBe(50.05);
  expect(calculateRetailPrice(null, -50)).toBeNull();
  expect(calculateRetailPrice(50, -50)).toBe(0);
  expect(() => calculateRetailPrice(50, -50.01)).toThrow();
  expect(() => calculateRetailPrice(99999999.99, 0.01)).toThrow();
});

test('来源指纹不受排列、检查时间影响，但包括同时间的来源价格', () => {
  const source = batch();
  const original = createSourceVersion(source, normalizeDuoSource(source));
  source.lastCheckedAt = new Date(0);
  source.items.reverse();
  expect(createSourceVersion(source, normalizeDuoSource(source))).toBe(original);
  source.items[0].wholesalePrice = 16500;
  expect(createSourceVersion(source, normalizeDuoSource(source))).not.toBe(original);
  source.items[0].wholesalePrice = '16000.25';
  source.items[0].officialPrice = 100;
  expect(createSourceVersion(source, normalizeDuoSource(source))).not.toBe(original);
});

test('默认加价、明确零加价、负数溢价取整和公开裁剪', () => {
  const source = normalizeDuoSource(batch());
  const defaultItems = mergeDuoItems(source);
  expect(defaultItems[0]).toMatchObject({ markup: 50, retailPrice: 16050.25, premiumAmount: 50 });
  const changed = mergeDuoItems(source, [{ productKey: source[0].productKey, markup: -50 }]);
  expect(changed[0]).toMatchObject({ markup: -50, retailPrice: 15950.25, premiumAmount: -50 });
  const zero = mergeDuoItems(source, [{ productKey: source[0].productKey, markup: 0 }]);
  expect(zero[0].retailPrice).toBe(16000.25);
  expect(publicDuoItem(changed[0])).not.toHaveProperty('markup');
  expect(publicDuoItem(changed[0])).not.toHaveProperty('wholesalePrice');
});
