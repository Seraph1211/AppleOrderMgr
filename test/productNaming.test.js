const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const {
  SKU_CATALOG,
  resolveProductName,
  formatProductCapacity,
} = require('../src/utils/productNaming');
const catalog = require('../src/data/productNamingV20261015.json');

describe('统一商品名称规则', () => {
  test.each(catalog)('$sku 全部容量与词序等价，无源对象改写', item => {
    for (const capacity of item.capacityAliases)
      for (const color of item.colorAliases)
        for (const name of [
          `${item.modelName} ${capacity} ${color}`,
          `${item.modelName} ${color} ${capacity}`,
        ]) {
          const product = { model: item.sku, name, quantity: 2 };
          const before = JSON.stringify(product);
          expect(resolveProductName(product)).toMatchObject({
            name: item.name,
            matched: true,
            needsReview: false,
          });
          expect(JSON.stringify(product)).toBe(before);
        }
  });
  test('前后端同源与冻结目录一致', () => {
    execFileSync(process.execPath, ['scripts/generateProductNaming.js', '--check']);
    expect(Object.keys(SKU_CATALOG)).toHaveLength(catalog.length);
    expect(fs.readFileSync('frontend/src/utils/productNaming.js', 'utf8')).toContain('自动生成');
  });
  test.each([
    { model: 'MJY64CH/A', name: 'iPhone 18 Pro Max 银色 256GB' },
    { model: 'MJY64CH/A', name: 'iPhone 18 Pro Max 黑色 256G 保护壳' },
    { name: 'iPhone Duo 酒红色 256GB' },
    { name: 'iPhone 18 Pro Max 黑色 256GB', title: 'iPhone 18 Pro Max 银色 256GB' },
    { model: 'MJY64CH/A', sku: 'MJY74CH/A', name: 'iPhone 18 Pro Max 黑色 256GB' },
    { name: 'iPhone 18 Pro Max 黑色 256GB', storageGb: 512 },
  ])('冲突、套装、跨型号颜色原文保留 %j', product => {
    expect(resolveProductName(product)).toMatchObject({
      name: product.name,
      matched: false,
      needsReview: true,
    });
  });
  test('结构化报价与代抢别名、缺名SKU', () => {
    expect(
      resolveProductName({ productModel: '18 Pro Max', color: '酒红色', storageGb: 1024 }).name
    ).toBe('iPhone 18 Pro Max 勃艮第酒红色 1T');
    expect(resolveProductName({ model: 'MJY64CH/A' }).name).toBe('iPhone 18 Pro Max 黑色 256G');
    expect(formatProductCapacity('2048GB')).toBe('2T');
  });
});

test('只为独立容量关键词扩展新旧单位，不改裸数字或其他文本', () => {
  const { expandProductNameAliases } = require('../src/utils/productNaming');
  expect(expandProductNameAliases(['1TB'])).toEqual(expect.arrayContaining(['1T', '1024GB', '1024G']));
  expect(expandProductNameAliases(['256GB'])).toEqual(expect.arrayContaining(['256G']));
  expect(expandProductNameAliases(['256', '每月256GB流量'])).toEqual(['256', '每月256GB流量']);
});

test('完整冲突对象经公开DTO裁剪后仍保留后端待核对结论', () => {
  const { serializePublicProducts } = require('../src/utils/orderSerialization');
  const full = { model: 'MJY64CH/A', sku: 'MJY74CH/A', name: 'iPhone 18 Pro Max 黑色 256GB', quantity: 2 };
  expect(resolveProductName(full)).toMatchObject({ matched: false, needsReview: true, reason: 'sku_conflict' });
  const [dto] = serializePublicProducts([full]);
  expect(dto).not.toHaveProperty('sku');
  expect(resolveProductName(dto)).toMatchObject({ name: full.name, matched: false, needsReview: true, reason: 'sku_conflict' });
  expect(resolveProductName({ displayName: '原始待核对名称', nameNeedsReview: true })).toMatchObject({ name: '原始待核对名称', matched: false, needsReview: true, reason: 'source_needs_review' });
  expect(resolveProductName({ model: 'MJY64CH/A', name: 'iPhone Duo 夜空色 256G', nameNeedsReview: false })).toMatchObject({ matched: false, needsReview: true });
});
