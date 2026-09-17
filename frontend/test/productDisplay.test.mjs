import test from 'node:test';
import assert from 'node:assert/strict';
import { groupDisplayProducts, formatProductSummary } from '../src/utils/productDisplay.js';

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
