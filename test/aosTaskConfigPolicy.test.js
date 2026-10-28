const policy = require('../src/services/aosTaskConfigPolicy');
const signal = require('../src/services/aosSignalPolicy');
const row = (
  stores = '北京三里屯|北京西单大悦城|广州天环广场',
  product = 'iPhone Duo 星光白色 512G',
  quantity = '2'
) => {
  const fields = Array(36).fill('');
  [fields[0], fields[1], fields[2], fields[3], fields[4]] = [
    'fixture@example.invalid',
    'private-fixture',
    stores,
    product,
    quantity,
  ];
  return fields.join(',');
};

test('每行计任务，重复账号和完全重复行保留；同城多店只计1、数量不乘', () => {
  const parsed = policy.parse([row(), row()].join('\n'));
  expect(parsed).toMatchObject({ valid: true, taskCount: 2, cityCount: 2, specCount: 1 });
  expect(parsed.aggregates.map(item => item.taskCount)).toEqual([2, 2]);
  expect(parsed.rows.map(item => item.rowNumber)).toEqual([1, 2]);
  expect(JSON.stringify(parsed)).not.toMatch(/private-fixture|fixture@example/);
});

test('空行单列、BOM和CRLF兼容；行号保持', () => {
  const parsed = policy.parse(`\uFEFF${row()}\r\n\r\n${row()}\r\n`);
  expect(parsed).toMatchObject({ valid: true, blankLineCount: 1, taskCount: 2 });
  expect(parsed.rows.map(item => item.rowNumber)).toEqual([1, 3]);
});

test.each([
  ['', 'EMPTY_CONFIG'],
  ['bad-secret-text', 'FIELD_COUNT'],
  [row('不存在的店'), 'STORE_UNKNOWN'],
  [row('北京三里屯|'), 'STORE_UNKNOWN'],
  [row('北京三里屯', 'iPhone Duo 星光白色 512G|iPhone Duo 夜空色 1T'), 'PRODUCT_UNKNOWN'],
  [row('北京三里屯', '未知手机'), 'PRODUCT_UNKNOWN'],
  [row('北京三里屯', 'iPhone Duo 星光白色 512G', '0'), 'QUANTITY_INVALID'],
])('错误行不得静默通过且不回显秘密', (text, code) => {
  const parsed = policy.parse(text);
  expect(parsed.valid).toBe(false);
  expect(parsed.errors[0].code).toBe(code);
  expect(JSON.stringify(parsed.errors)).not.toMatch(
    /bad-secret-text|private-fixture|fixture@example/
  );
});

test('一行错误令整批不可激活', () => {
  expect(policy.parse(`${row()}\nbad-secret-text`)).toMatchObject({ valid: false, taskCount: 1 });
});

test('全文摘要区分账号变化与空行位置变化，统计同值不冒充同文件', () => {
  const a = policy.parse(row());
  const b = policy.parse(row().replace('fixture@example.invalid', 'other@example.invalid'));
  const c = policy.parse(`\n${row()}`);
  expect(a.aggregates).toEqual(b.aggregates);
  expect(a.contentHash).not.toEqual(b.contentHash);
  expect(a.contentHash).not.toEqual(c.contentHash);
});

test('标准CSV引号及逗号不会破坏字段数量', () => {
  const input = row().replace('private-fixture', '"private,fixture"');
  expect(policy.parse(input).valid).toBe(true);
  expect(policy.parse(input.replace('"private,fixture"', '"private,fixture')).valid).toBe(false);
});

test('差异保留已移除城市和规格的归零行', () => {
  const a = policy.parse(row()).aggregates;
  const b = policy.parse(row('北京三里屯')).aggregates;
  expect(policy.differences(a, b)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ city: '广州', previousCount: 1, nextCount: 0, delta: -1 }),
    ])
  );
});

test('信号直接提取原始任务编号，不等索引、不去掉前导零', () => {
  const now = Date.parse('2026-10-28T12:00:00+08:00');
  const parsed = signal.parseEntry(
    {
      id: 'id',
      deviceId: 'dev',
      localId: 'local',
      fileId: 'file',
      byteOffset: 1,
      loggedAt: new Date(now).toISOString(),
      parseState: 'parsed',
      partIndex: 0,
      message: '2026-10-28 12:00:00.000 [2][001]A33-取货信息: 取货日期待付款完成后确定',
    },
    now
  );
  expect(parsed.accountNumber).toBe('001');
});

module.exports = { row };
