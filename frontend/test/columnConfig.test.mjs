import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appleIdsColumns,
  ordersColumns,
  recipientsColumns,
} from '../src/constants/tableColumns.js';
import { mergeColumnConfig } from '../src/utils/columnConfig.js';

const defaults = [
  { key: 'name', defaultVisible: true },
  { key: 'tag', defaultVisible: true },
  { key: 'newField', defaultVisible: false },
  { key: 'actions', defaultVisible: true, pinned: true },
];

test('恢复保存的列顺序和可见性，并在固定操作列前加入新列', () => {
  const merged = mergeColumnConfig(defaults, [
    { key: 'actions', visible: true, order: 2 },
    { key: 'tag', visible: false, order: 0 },
    { key: 'name', visible: true, order: 1 },
  ]);

  assert.deepEqual(
    merged.map(column => [column.key, column.visible]),
    [
      ['tag', false],
      ['name', true],
      ['newField', false],
      ['actions', true],
    ]
  );
});

test('损坏顺序回退到保存数组顺序，未知旧列被移除', () => {
  const merged = mergeColumnConfig(defaults, [
    { key: 'tag', visible: true, order: 'bad' },
    { key: 'retired', visible: true, order: 0 },
    { key: 'name', visible: false },
  ]);

  assert.deepEqual(
    merged.map(column => column.key),
    ['tag', 'name', 'newField', 'actions']
  );
  assert.equal(merged.find(column => column.key === 'name').visible, false);
});

for (const [name, columns] of [
  ['订单', ordersColumns],
  ['Apple ID', appleIdsColumns],
  ['取机人', recipientsColumns],
]) {
  test(`${name}页面恢复用户保存的列顺序`, () => {
    const configurable = columns.filter(column => !column.pinned);
    const saved = [configurable[1], configurable[0], ...configurable.slice(2)].map(
      (column, order) => ({ key: column.key, visible: column.defaultVisible, order })
    );
    const merged = mergeColumnConfig(columns, saved);
    assert.deepEqual(
      merged.slice(0, 2).map(column => column.key),
      [configurable[1].key, configurable[0].key]
    );
  });
}
