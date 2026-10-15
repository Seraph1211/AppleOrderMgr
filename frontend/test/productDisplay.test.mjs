import test from 'node:test';
import assert from 'node:assert/strict';
import { groupDisplayProducts, formatProductSummary } from '../src/utils/productDisplay.js';
import { formatProductStorageText } from '../src/utils/productStorage.js';

test('重复商品合并为 ×2，保留顺序且不改源记录', () => {
  const name = 'iPhone 18 Pro Max 512GB 冰川蓝色';
  const products = [
    { name, model: 'M1', quantity: 1 },
    { name: 'B', quantity: 2 },
    { name, model: 'M1', quantity: 1 },
  ];
  const original = JSON.stringify(products);
  assert.equal(formatProductSummary(products), `${name} ×2、B ×2`);
  assert.equal(JSON.stringify(products), original);
});

test('不同型号／名称不合并，零数量保留，不猜测未知数量', () => {
  assert.deepEqual(
    groupDisplayProducts([
      { name: ' A ', model: 'M1', quantity: '2' },
      { name: 'A', model: 'M1', quantity: 0 },
      { name: 'A', model: 'M2', quantity: 1 },
      { name: 'B', quantity: 0 },
      { name: 'C', quantity: 1 },
      { name: 'C' },
    ]),
    [
      { name: 'A', quantity: 2 },
      { name: 'A', quantity: 1 },
      { name: 'B', quantity: 0 },
      { name: 'C', quantity: null },
    ]
  );
  for (const quantity of [null, undefined, '', -1, 0.5, true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(formatProductSummary([{ name: 'A', quantity }]), 'A ×待核实');
  }
  assert.equal(formatProductSummary([null, {}]), '-');
  assert.equal(formatProductSummary(null), '-');
});

test('容量展示规范化且原始明细、型号分组语义不变', () => {
  const products = [
    { name: 'iPhone Duo 1024GB 星光白色', model: 'MK2T4CH/A', quantity: 1 },
    { name: 'iPhone Duo 1024GB 星光白色', model: 'MK2T4CH/A', quantity: 2 },
    { name: 'iPhone Duo 1TB 星光白色', model: 'MK2T4CH/A', quantity: 4 },
    { model: 'iPhone Duo 2048 GB 夜空色', quantity: 1 },
  ];
  const original = JSON.stringify(products);
  assert.deepEqual(groupDisplayProducts(products), [
    { name: 'iPhone Duo 1TB 星光白色', quantity: 3 },
    { name: 'iPhone Duo 1TB 星光白色', quantity: 4 },
    { name: 'iPhone Duo 2TB 夜空色', quantity: 1 },
  ]);
  assert.equal(JSON.stringify(products), original);
});

test('容量token只转换明确单位，不改小数、正负数、序列号或原TB', () => {
  const unchanged = [
    '1.1024GB', '-1024GB', '+1024GB', '11024GB',
    'X1024GB', '1024GBSN', '_2048GB', '1TB',
  ];
  for (const value of unchanged) {
    assert.equal(formatProductStorageText(value), value);
  }
  assert.equal(formatProductStorageText('容量1024GB / 2048 gb'), '容量1TB / 2TB');
});
