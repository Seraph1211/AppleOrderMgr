import { resolveProductName, getProductDisplayName } from '../src/utils/productNaming.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupDisplayProducts, formatProductSummary } from '../src/utils/productDisplay.js';
import { formatProductStorageText } from '../src/utils/productStorage.js';

test('重复商品合并为 ×2，保留顺序且不改源记录', () => {
  const name = 'iPhone 18 Pro Max 512GB 冰川蓝色';
  const products = [
    { name, model: 'MJYE4CH/A', quantity: 1 },
    { name: 'B', quantity: 2 },
    { name, model: 'MJYE4CH/A', quantity: 1 },
  ];
  const original = JSON.stringify(products);
  assert.equal(formatProductSummary(products), 'iPhone 18 Pro Max 冰川蓝色 512G ×2、B ×2');
  assert.equal(JSON.stringify(products), original);
});

test('不同型号／名称不合并，零数量保留，不猜测未知数量', () => {
  assert.deepEqual(
    groupDisplayProducts([
      { name: ' A ', model: 'M1', quantity: '2' },
      { name: 'A', model: 'M1', quantity: 0 },
      { name: 'A', model: 'M2', quantity: 1 },
      { name: 'B', quantity: 0, filterNeedsReview: true },
      { name: 'C', quantity: 1 },
      { name: 'C' },
    ]),
    [
      { name: 'A', quantity: 2, filterNeedsReview: true },
      { name: 'A', quantity: 1, filterNeedsReview: true },
      { name: 'B', quantity: 0, filterNeedsReview: true },
      { name: 'C', quantity: null, filterNeedsReview: true },
    ]
  );
  for (const quantity of [null, undefined, '', -1, 0.5, true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(formatProductSummary([{ name: 'A', quantity }]), 'A ×待核实');
  }
  assert.equal(formatProductSummary([null, {}]), '-');
  assert.equal(formatProductSummary(null), '-');
});

test('同身份容量变体统一合并，原始明细不变', () => {
  const products = [
    { name: 'iPhone Duo 1024GB 星光白色', model: 'MK2T4CH/A', quantity: 1 },
    { name: 'iPhone Duo 1024GB 星光白色', model: 'MK2T4CH/A', quantity: 2 },
    { name: 'iPhone Duo 1TB 星光白色', model: 'MK2T4CH/A', quantity: 4 },
    { model: 'iPhone Duo 2048 GB 夜空色', quantity: 1 },
  ];
  const original = JSON.stringify(products);
  assert.deepEqual(groupDisplayProducts(products), [
    { name: 'iPhone Duo 星光白色 1T', quantity: 7 },
    { name: 'iPhone Duo 夜空色 2T', quantity: 1 },
  ]);
  assert.equal(JSON.stringify(products), original);
});

test('不将非商品自由文本、异常数字或序列号当商品改写', () => {
  const unchanged = ['1.1024GB', '-1024GB', '+1024GB', '11024GB', 'X1024GB', '1024GBSN', '_2048GB'];
  for (const value of unchanged) {
    assert.equal(formatProductStorageText(value), value);
  }
  assert.equal(formatProductStorageText('容量1024GB / 2048 gb'), '容量1024GB / 2048 gb');
});

test('相同标准名不会跨SKU或商品ID合并，待核对提示不丢失', () => {
  const name = 'iPhone 18 Pro Max 黑色 256G';
  const items = [
    { name, model: 'MJY64CH/A', quantity: 1, productId: 'a', filterNeedsReview: true },
    { name, model: 'MJY64CH/A', quantity: 1, productId: 'b' },
    { name, model: 'MJY74CH/A', quantity: 2 },
    { name, quantity: 4 },
  ];
  const before = JSON.stringify(items);
  const groups = groupDisplayProducts(items);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].filterNeedsReview, true);
  assert.equal(groups[2].filterNeedsReview, true);
  assert.equal(JSON.stringify(items), before);
});

test('同SKU标准化后仍合并历史筛选键并保留待核对状态', () => {
  const groups = groupDisplayProducts([
    { name: 'iPhone 18 Pro Max 256GB 黑色', model: 'MJY64CH/A', quantity: 1, filterKeys: ['old'] },
    {
      name: 'iPhone 18 Pro Max 黑色 256G',
      model: 'MJY64CH/A',
      quantity: 2,
      filterKeys: ['new'],
      filterNeedsReview: true,
    },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].quantity, 3);
  assert.deepEqual(groups[0].filterKeys, ['old', 'new']);
  assert.equal(groups[0].filterNeedsReview, true);
});

test('后端标为待核对的精简DTO保留原名，不能重新确认身份或并入已确认商品', () => {
  const name = 'iPhone 18 Pro Max 256GB 黑色';
  const reviewed = {
    name,
    model: 'MJY64CH/A',
    nameNeedsReview: true,
    nameReviewReason: 'sku_conflict',
    quantity: 4,
  };
  const before = JSON.stringify(reviewed);
  const resolution = resolveProductName(reviewed);
  assert.equal(resolution.matched, false);
  assert.equal(resolution.needsReview, true);
  assert.equal(resolution.identity, null);
  assert.equal(getProductDisplayName(reviewed), name);
  const groups = groupDisplayProducts([
    { name, model: 'MJY64CH/A', quantity: 1 },
    reviewed,
    { ...reviewed, quantity: 2 },
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].name, 'iPhone 18 Pro Max 黑色 256G');
  assert.equal(groups[0].quantity, 1);
  assert.equal(groups[1].name, name);
  assert.equal(groups[1].quantity, 4);
  assert.equal(groups[1].filterNeedsReview, true);
  assert.equal(groups[2].quantity, 2);
  assert.equal(JSON.stringify(reviewed), before);
});

test('冲突商品按全部显式SKU及两个商品ID字段区分，不能用短路选择丢失冲突差异', () => {
  const name = 'iPhone 18 Pro Max 黑色 256G';
  const base = { name, model: 'MJY64CH/A', sku: 'MJY64CH/A', quantity: 1 };
  for (const field of ['skuCode', 'partNumber', 'product_sku']) {
    const groups = groupDisplayProducts([
      { ...base, [field]: 'MJY74CH/A' },
      { ...base, [field]: 'MJY84CH/A' },
    ]);
    assert.equal(groups.length, 2, field);
    assert.equal(groups[0].filterNeedsReview, true);
  }
  assert.equal(
    groupDisplayProducts([
      { ...base, product_id: 'a' },
      { ...base, product_id: 'b' },
    ]).length,
    2
  );
  assert.equal(
    groupDisplayProducts([
      { ...base, productId: 'same', product_id: 'a' },
      { ...base, productId: 'same', product_id: 'b' },
    ]).length,
    2
  );
});
