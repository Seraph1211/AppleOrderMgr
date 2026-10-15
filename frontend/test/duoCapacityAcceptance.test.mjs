import assert from 'node:assert/strict';
import test from 'node:test';
import { formatStorageCapacity, formatProductStorageText } from '../src/utils/productStorage.js';
import { groupDisplayProducts, formatProductSummary } from '../src/utils/productDisplay.js';

test('商品容量统一使用G和T，内部数值不变', () => {
  for (const [value, expected] of [
    [256, '256G'],
    [512, '512G'],
    [1024, '1T'],
    [2048, '2T'],
    ['1024', '1T'],
    ['2048', '2T'],
  ]) {
    assert.equal(formatStorageCapacity(value), expected);
  }
});

test('应该仅转换明确容量token而不修改其他文本', () => {
  for (const [value, expected] of [
    ['iPhone Duo 1024GB 星光白色', 'iPhone Duo 星光白色 1T'],
    ['iPhone 18 Pro Max 2048 GB 黑色', 'iPhone 18 Pro Max 黑色 2T'],
    ['1024gb / 2048gb / 256GB / 512GB', '1024gb / 2048gb / 256GB / 512GB'],
    ['iPhone Duo 1TB 夜空色', 'iPhone Duo 夜空色 1T'],
    ['11024GB A1024GB 1024GB123 2048GBX', '11024GB A1024GB 1024GB123 2048GBX'],
    ['1.1024GB -1024GB 0.2048GB -2048GB', '1.1024GB -1024GB 0.2048GB -2048GB'],
    ['MK2T4CH/A AO12CD34EF 1024', 'MK2T4CH/A AO12CD34EF 1024'],
  ])
    assert.equal(formatProductStorageText(value), expected);
});

test('应该保留原始分组身份和过滤key，只改变展示容量', () => {
  const products = [
    {
      name: 'iPhone Duo 1024GB 星光白色',
      model: 'MK2T4CH/A',
      quantity: 1,
      filterKeys: ['raw-1024'],
    },
    {
      name: 'iPhone Duo 1024GB 星光白色',
      model: 'MK2T4CH/A',
      quantity: 2,
      filterKeys: ['raw-next'],
    },
    { name: 'iPhone Duo 星光白色 1T', model: 'MK2T4CH/A', quantity: 4, filterKeys: ['canonical'] },
    { model: 'iPhone 18 Pro Max 2048GB 黑色', quantity: 0 },
    { name: 'iPhone Duo 512GB 夜空色', quantity: 1 },
  ];
  const before = JSON.stringify(products);
  const groups = groupDisplayProducts(products);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].name, 'iPhone Duo 星光白色 1T');
  assert.equal(groups[0].quantity, 7);
  assert.deepEqual(groups[0].filterKeys, ['raw-1024', 'raw-next', 'canonical']);
  assert.equal(groups[1].name, 'iPhone 18 Pro Max 黑色 2T');
  assert.equal(groups[1].quantity, 0);
  assert.equal(groups[2].name, 'iPhone Duo 夜空色 512G');
  assert.equal(JSON.stringify(products), before);
  assert.match(formatProductSummary(products), /iPhone Duo 星光白色 1T ×7/);
  assert.equal(JSON.stringify(products), before);
});
