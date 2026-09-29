const ApiError = require('../src/utils/ApiError');
const {
  applyDisplayOrder,
  createProductKey,
  formatStorage,
  productName,
  calculateQuotePrice,
  normalizeSourceItems,
  validateAdjustment,
} = require('../src/services/quotePricingCore');

const sourceRow = overrides => ({
  productModel: '18 Pro',
  storageGb: 256,
  color: '黑色',
  specCode: 'TQ4/T74',
  basePrice: 10000,
  officialPrice: 9999,
  sourceUpdatedAt: new Date('2026-09-24T10:01:21.000Z'),
  crawledAt: new Date('2026-09-24T10:04:01.000Z'),
  ...overrides,
});

describe('iPhone 18 公开报价计算', () => {
  test('先按百分比调整，再加固定金额并四舍五入', () => {
    expect(calculateQuotePrice(10000, 5, -100)).toBe(10400);
    expect(calculateQuotePrice(9999, 2.5, 0)).toBe(10249);
  });

  test('拒绝负数最终报价及超范围调整', () => {
    expect(() => calculateQuotePrice(100, -100, -1)).toThrow(ApiError);
    expect(() => validateAdjustment(1000.01, 0)).toThrow('超出允许范围');
    expect(() => validateAdjustment(0, -100000.01)).toThrow('超出允许范围');
  });

  test('商品键只由型号、容量和颜色生成，规格码变化不改变规则', () => {
    expect(createProductKey(sourceRow())).toBe(
      createProductKey(sourceRow({ specCode: 'NEW-CODE', basePrice: 12000 }))
    );
    expect(productName(sourceRow())).toBe('iPhone 18 Pro 256GB 黑色');
    expect(formatStorage(1024)).toBe('1TB');
    expect(formatStorage(2048)).toBe('2TB');
  });

  test('接纳来源实际商品列表并拒绝重复商品', () => {
    const rows = [sourceRow(), sourceRow({ productModel: '18 Pro Max', color: '银色' })];
    const normalized = normalizeSourceItems(rows);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toMatchObject({
      productName: 'iPhone 18 Pro 256GB 黑色',
      productKey: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(normalizeSourceItems([sourceRow()])).toHaveLength(1);
    expect(() => normalizeSourceItems([...rows, sourceRow()])).toThrow('报价数据暂不可用');
  });

  test.each([null, undefined, '', '  ', 0, '0.00'])('缺失价格 %p 不转换为零元报价', value => {
    const [item] = normalizeSourceItems([sourceRow({ basePrice: value, officialPrice: value })]);
    expect(item).toMatchObject({ basePrice: null, officialPrice: null });
    expect(calculateQuotePrice(item.basePrice, 5, 200)).toBeNull();
    expect(calculateQuotePrice(item.basePrice, 0, -200)).toBeNull();
  });

  test.each([-1, 'invalid', Infinity, NaN, true, []])('非法数字价格 %p 仍受控拒绝', value => {
    expect(() => normalizeSourceItems([sourceRow({ basePrice: value })])).toThrow(ApiError);
    expect(() => normalizeSourceItems([sourceRow({ officialPrice: value })])).toThrow(ApiError);
  });

  test('空批次或无效商品身份仍拒绝', () => {
    for (const rows of [[], [sourceRow({ color: '' })], [sourceRow({ storageGb: 0 })]]) {
      expect(() => normalizeSourceItems(rows)).toThrow(ApiError);
    }
  });

  test('新增容量时按动态结构接纳批次，不限制固定商品数量', () => {
    const colors = ['黑色', '银色', '冰川蓝色', '勃艮第酒红色'];
    const rows = ['18 Pro', '18 Pro Max'].flatMap(productModel =>
      [256, 512, 1024, 2048].flatMap(storageGb =>
        colors.map((color, index) =>
          sourceRow({ productModel, storageGb, color, basePrice: 10000 + index })
        )
      )
    );

    expect(normalizeSourceItems(rows)).toHaveLength(32);
  });

  test('来源某容量只有部分颜色时仍展示当期商品', () => {
    const rows = [
      sourceRow(),
      sourceRow({ color: '银色' }),
      sourceRow({ storageGb: 512 }),
      sourceRow({ productModel: '18 Pro Max', color: '黑色' }),
    ];

    expect(normalizeSourceItems(rows)).toHaveLength(rows.length);
  });

  test('所有容量均按黑色、银色、冰川蓝色、勃艮第酒红色排列', () => {
    const rows = [
      sourceRow({ storageGb: 512, color: '勃艮第酒红色' }),
      sourceRow({ color: '冰川蓝色' }),
      sourceRow({ color: '银色' }),
      sourceRow({ color: '勃艮第酒红色' }),
      sourceRow(),
      sourceRow({ storageGb: 512, color: '黑色' }),
      sourceRow({ storageGb: 512, color: '银色' }),
      sourceRow({ storageGb: 512, color: '冰川蓝色' }),
      sourceRow({ productModel: '18 Pro Max', color: '黑色' }),
    ];

    expect(
      normalizeSourceItems(rows).map(item =>
        [item.productModel, item.storageGb, item.color].join('|')
      )
    ).toEqual([
      '18 Pro|256|黑色',
      '18 Pro|256|银色',
      '18 Pro|256|冰川蓝色',
      '18 Pro|256|勃艮第酒红色',
      '18 Pro|512|黑色',
      '18 Pro|512|银色',
      '18 Pro|512|冰川蓝色',
      '18 Pro|512|勃艮第酒红色',
      '18 Pro Max|256|黑色',
    ]);
  });

  test('后台展示顺序优先，未配置的新商品按默认顺序追加', () => {
    const items = [
      { productKey: 'a', productName: 'A' },
      { productKey: 'b', productName: 'B' },
      { productKey: 'c', productName: 'C' },
    ];

    expect(applyDisplayOrder(items, ['b', 'a']).map(item => item.productKey)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(applyDisplayOrder(items, ['missing', 'b', 'b']).map(item => item.productKey)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(items.map(item => item.productKey)).toEqual(['a', 'b', 'c']);
  });
});
