import assert from 'node:assert/strict';
import test from 'node:test';
import { togglePageSelection, buildAppleIdBatchPayload } from '../src/utils/appleIdBatch.js';
import { getAppleIdStatusBadge } from '../src/constants/appleIdStatus.js';
import { formatAppleIdSecurityQuestion } from '../src/utils/appleIdSecurityQa.js';
import { resolveAppleIdColumnConfig } from '../src/utils/columnConfig.js';
import { appleIdsColumns } from '../src/constants/tableColumns.js';

test('跨页选择与当前页取消保留其他页 ID', () => {
  const first = togglePageSelection(new Set([1]), [2, 3], true);
  assert.deepEqual([...first], [1, 2, 3]);
  assert.deepEqual([...togglePageSelection(first, [2, 3], false)], [1]);
});
test('仅发送勾选字段，空备注明确清空', () => {
  assert.deepEqual(buildAppleIdBatchPayload([1], { changeStatus: true, status: '异常' }), {
    ids: [1],
    status: '异常',
  });
  assert.deepEqual(buildAppleIdBatchPayload([1], { changeNotes: true, notes: '' }), {
    ids: [1],
    notes: null,
  });
  assert.deepEqual(buildAppleIdBatchPayload([1], { changeNotes: true, notes: '新备注' }), {
    ids: [1],
    notes: '新备注',
  });
  assert.throws(() => buildAppleIdBatchPayload([1], {}), /请勾选/);
});
test('Apple ID 四种状态配色及未知灰色', () => {
  assert.deepEqual(
    ['未使用', '使用中', '已下架', '异常', '未知'].map(
      status => getAppleIdStatusBadge(status).class
    ),
    [
      'badge-info',
      'badge-success',
      'bg-gray-100 text-gray-700 border-gray-200',
      'badge-error',
      'bg-gray-100 text-gray-700 border-gray-200',
    ]
  );
});
test('截图中的 130–147 问题编码显示完整原文，未知编码保持原值', () => {
  const questions = [
    '你少年时代最好的朋友叫什么名字？',
    '你的第一个宠物叫什么名字？',
    '你学会做的第一道菜是什么？',
    '你第一次去电影院看的是哪一部电影？',
    '你第一次坐飞机是去哪里？',
    '你上小学时最喜欢的老师姓什么？',
    '你的理想工作是什么？',
    '你小时候最喜欢哪一本书？',
    '你拥有的第一辆车是什么型号？',
    '你童年时代的绰号是什么？',
    '你在学生时代最喜欢哪个电影明星或角色？',
    '你在学生时代最喜欢哪个歌手或乐队？',
    '你的父母是在哪里认识的？',
    '你的第一个上司叫什么名字？',
    '你从小长大的那条街叫什么？',
    '你去过的第一个海滨浴场是哪一个？',
    '你购买的第一张专辑是什么？',
    '你最喜欢哪个球队？',
  ];
  questions.forEach((question, index) => {
    const code = 130 + index;
    assert.equal(formatAppleIdSecurityQuestion(code), `${code} / ${question}`);
    assert.equal(formatAppleIdSecurityQuestion(String(code)), `${code} / ${question}`);
  });
  assert.equal(formatAppleIdSecurityQuestion('Aa36'), 'Aa36');
  assert.equal(formatAppleIdSecurityQuestion('自定义问题？'), '自定义问题？');
  assert.equal(formatAppleIdSecurityQuestion(null), '—');
});
test('默认展示列按确认顺序排列', () => {
  assert.deepEqual(
    appleIdsColumns.filter(column => column.defaultVisible).map(column => column.key),
    [
      'accountNumber',
      'appleId',
      'password',
      'country',
      'status',
      'orderCount',
      'lastOrderDate',
      'notes',
      'actions',
    ]
  );
});

test('Apple ID 旧保存布局恢复新默认，新版保存配置保留自定义', () => {
  const columns = [
    { key: 'notes', visible: false, order: 0 },
    { key: 'appleId', visible: true, order: 1 },
  ];
  const migrated = resolveAppleIdColumnConfig(appleIdsColumns, { columns });
  assert.deepEqual(
    migrated.filter(column => column.visible).map(column => column.key),
    [
      'accountNumber',
      'appleId',
      'password',
      'country',
      'status',
      'orderCount',
      'lastOrderDate',
      'notes',
      'actions',
    ]
  );
  const saved = resolveAppleIdColumnConfig(appleIdsColumns, { layoutVersion: 1, columns });
  assert.equal(saved[0].key, 'notes');
  assert.equal(saved[0].visible, false);
});
