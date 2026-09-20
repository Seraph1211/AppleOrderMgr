const {
  normalizeSku,
  normalizeProductName,
  buildProductFilterItems,
  collectProductOptions,
} = require('../src/utils/productFilter');
const { parseProductKeys } = require('../src/utils/productFilterQuery');
const source = { model: 'MJYD4CH/A', name: 'iPhone 18 Pro Max 勃艮第酒红色 512G', quantity: 1 };
const official = { ...source, name: 'iPhone 18 Pro Max 512GB 勃艮第酒红色' };

test('入库即支持 SKU，无需官网时间、状态或网络', () => {
  expect(buildProductFilterItems([source])[0]).toMatchObject({
    key: 'sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478',
    needsReview: false,
    productIndex: 0,
  });
  expect(normalizeSku(' mjyd4ch/a ')).toBe('MJYD4CH/A');
  expect(normalizeSku('iPhone 18 Pro Max')).toBe('');
  expect(normalizeSku(null)).toBe('');
});

test('两种容量词序、大小写和不换行空格归一；不同颜色容量不等价', () => {
  expect(normalizeProductName(source.name)).toBe(normalizeProductName(official.name));
  expect(normalizeProductName('iPhone\u00a017 256G 白色')).toBe(
    normalizeProductName('IPHONE 17 白色 256GB')
  );
  expect(normalizeProductName('手机 黑色 1T')).toBe(normalizeProductName('手机 1TB 黑色'));
  expect(normalizeProductName('手机 256G 黑色')).not.toBe(normalizeProductName('手机 512G 黑色'));
  expect(normalizeProductName('手机 256G 黑色')).not.toBe(normalizeProductName('手机 256G 白色'));
});

test('官网名称补充保留 SKU，别名可搜，原业务数据不改变', () => {
  const original = JSON.stringify(source);
  const before = buildProductFilterItems([source]);
  const after = buildProductFilterItems([official], before, [source]);
  expect(after[0].keys).toContain(before[0].key);
  expect(after[0].aliases).toEqual(expect.arrayContaining([source.name, official.name]));
  expect(after[0].needsReview).toBe(false);
  expect(JSON.stringify(source)).toBe(original);
});

test('缺 SKU 仍可选；唯一来源匹配恢复型号并保留旧名称键', () => {
  const unknown = { ...source, model: null };
  const before = buildProductFilterItems([unknown]);
  expect(before[0]).toMatchObject({ needsReview: true, model: null });
  expect(before[0].key).toMatch(/^name:/);
  const after = buildProductFilterItems([official], before);
  expect(after[0].keys).toEqual(
    expect.arrayContaining([
      before[0].key,
      'sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478',
    ])
  );
  expect(buildProductFilterItems([{ ...official, model: null }], [], [source])[0].model).toBe(
    source.model
  );
});

test('多个可能型号或不同名称不能凭数组位置猜测恢复', () => {
  const other = { ...source, model: 'MJYA4CH/A' };
  expect(
    buildProductFilterItems([{ ...official, model: null }], [], [source, other])[0].model
  ).toBeNull();
  expect(
    buildProductFilterItems([{ name: '完全不同的商品', quantity: 1 }], [], [source])[0].model
  ).toBeNull();
});

test('官网纠正明确 SKU 后不再命中旧键，也不混用名称别名', () => {
  const before = buildProductFilterItems([source]);
  const after = buildProductFilterItems([{ ...official, model: 'MJYA4CH/A' }], before, [source]);
  expect(after[0].keys).not.toContain(before[0].key);
  expect(after[0].needsReview).toBe(true);
});

test('同 SKU 但属性冲突保留独立待核对项', () => {
  const before = buildProductFilterItems([source]);
  const corrected = { ...source, name: 'iPhone 18 Pro Max 黑色 256G' };
  const after = buildProductFilterItems([corrected], before, [source]);
  expect(after[0].key).toMatch(/^review:/);
  expect(after[0].keys).not.toContain(before[0].key);
  expect(after[0].aliases).toEqual([corrected.name]);
});

test('候选归组按订单去重，保留 SKU 与别名；缺失数据不抛异常', () => {
  const rows = [
    { products: [source, source], productFilterItems: buildProductFilterItems([source, source]) },
    { products: [official] },
  ];
  const options = collectProductOptions(rows);
  expect(options).toHaveLength(1);
  expect(options[0]).toMatchObject({
    value: 'sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478',
    count: 2,
  });
  expect(options[0].aliases).toHaveLength(2);
  expect(buildProductFilterItems(null)).toEqual([]);
  expect(collectProductOptions([{ products: [] }])).toEqual([]);
  expect(buildProductFilterItems([{}])[0].needsReview).toBe(true);
});

test.each([
  '[',
  '{}',
  '[1]',
  '["sku:bad"]',
  JSON.stringify(
    Array(101).fill(
      'sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478'
    )
  ),
])('非法商品键拒绝：%s', value => {
  expect(() => parseProductKeys(value)).toThrow();
});

test('合法商品键去重，空值兼容', () => {
  expect(parseProductKeys(undefined)).toEqual([]);
  expect(parseProductKeys('')).toEqual([]);
  expect(
    parseProductKeys(
      JSON.stringify([
        'sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478',
        'sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478',
      ])
    )
  ).toEqual(['sku:MJYD4CH/A:e72d13c5ecf63b929747f62f8b5fd42d7a7a04565a2a9bc11bef5d737e2a9478']);
});

test('不同订单误录同 SKU 的不同容量颜色不能合并为同一选项', () => {
  const altered = { ...source, name: 'iPhone 18 Pro Max 黑色 256G' };
  const left = buildProductFilterItems([source]);
  const right = buildProductFilterItems([altered]);
  expect(left[0].key).not.toBe(right[0].key);
  const options = collectProductOptions([
    { productFilterItems: left },
    { productFilterItems: right },
  ]);
  expect(options).toHaveLength(2);
  expect(options.every(option => option.needsReview && option.count === 1)).toBe(true);
});

test('重复同步不能自动清除同 SKU 属性冲突，模糊缺型号不继承旧键到多个型号', () => {
  const altered = { ...source, name: 'iPhone 18 Pro Max 黑色 256G' };
  const conflict = buildProductFilterItems([altered], buildProductFilterItems([source]), [source]);
  const repeated = buildProductFilterItems([altered], conflict, [source]);
  expect(repeated[0].key).toBe(conflict[0].key);
  expect(repeated[0].needsReview).toBe(true);
  const old = buildProductFilterItems([{ ...source, model: null }]);
  const ambiguous = buildProductFilterItems([source, { ...source, model: 'MJYA4CH/A' }], old);
  expect(ambiguous.every(item => !item.keys.includes(old[0].key))).toBe(true);
});

test('历史名称键计数只包含真正继承该键的订单，不使用整组 SKU 数量', () => {
  const old = buildProductFilterItems([{ ...source, model: null }]);
  const inherited = buildProductFilterItems([official], old);
  const direct = buildProductFilterItems([source]);
  const [option] = collectProductOptions([
    { productFilterItems: inherited },
    { productFilterItems: direct },
  ]);
  expect(option.count).toBe(2);
  expect(option.keyCounts[old[0].key]).toBe(1);
});
