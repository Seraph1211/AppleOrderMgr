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
  [row('北京三里屯', 'iPhone Duo 星光白色 512G|未知手机'), 'PRODUCT_UNKNOWN'],
  [row('北京三里屯', '|iPhone Duo 星光白色 512G'), 'PRODUCT_UNKNOWN'],
  [row('北京三里屯', 'iPhone Duo 星光白色 512G|'), 'PRODUCT_UNKNOWN'],
  [row('北京三里屯', 'iPhone Duo 星光白色 512G||iPhone Duo 夜空色 1T'), 'PRODUCT_UNKNOWN'],
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

test('上海8店同一行选择5规格，各规格分母1，任务总数仍为1且数量2不相乘', () => {
  const parsed = policy.parse(
    row(
      '上海浦东|上海静安|上海环球港|上海五角场|上海七宝|上海环贸 iapm|上海香港广场|上海南京东路',
      'iPhone Duo 星光白色 512G|iPhone Duo 星光白色 2T|iPhone Duo 夜空色 2T|iPhone Duo 星光白色 1T|iPhone Duo 夜空色 1T'
    )
  );
  expect(parsed).toMatchObject({ valid: true, taskCount: 1, cityCount: 1, specCount: 5 });
  expect(parsed.rows[0].storeCodes).toHaveLength(8);
  expect(parsed.rows[0].products).toEqual([
    { model: 'iPhone Duo', color: '星光白色', capacity: '512G' },
    { model: 'iPhone Duo', color: '星光白色', capacity: '2T' },
    { model: 'iPhone Duo', color: '夜空色', capacity: '2T' },
    { model: 'iPhone Duo', color: '星光白色', capacity: '1T' },
    { model: 'iPhone Duo', color: '夜空色', capacity: '1T' },
  ]);
  expect(parsed.rows[0]).not.toHaveProperty('model');
  expect(parsed.rows[0]).not.toHaveProperty('color');
  expect(parsed.rows[0]).not.toHaveProperty('capacity');
  expect(parsed.aggregates).toHaveLength(5);
  expect(parsed.aggregates.every(item => item.city === '上海' && item.taskCount === 1)).toBe(true);
  expect(JSON.stringify(parsed)).not.toMatch(/private-fixture|fixture@example/);
});

test.each(['unknown-private-product', ''])('第二项未知或为空时只报告位置，不回显输入', value => {
  const parsed = policy.parse(row('上海浦东', `iPhone Duo 星光白色 512G|${value}`));
  expect(parsed.errors).toEqual([
    {
      rowNumber: 1,
      field: 'product',
      code: 'PRODUCT_UNKNOWN',
      message: '第4字段第2项商品规格为空或无法唯一识别，请核对机型、颜色和容量',
    },
  ]);
  expect(JSON.stringify(parsed.errors)).not.toMatch(
    /unknown-private-product|private-fixture|fixture@example/
  );
});

test('同行重复或容量别名SKU归一为一次，跨城分别计数，重复配置行仍各计一次', () => {
  const text = row(
    '北京三里屯|北京西单大悦城|广州天环广场',
    'iPhone Duo 星光白色 1024GB|iPhone Duo 夜空色 2T|iPhone Duo 星光白色 1T|iPhone Duo 夜空色 2T'
  );
  const parsed = policy.parse(`${text}\n${text}`);
  expect(parsed).toMatchObject({ valid: true, taskCount: 2, cityCount: 2, specCount: 2 });
  expect(parsed.rows.every(item => item.products.length === 2)).toBe(true);
  expect(parsed.rows[0].products[0]).toMatchObject({ capacity: '1T' });
  expect(parsed.aggregates).toHaveLength(4);
  expect(parsed.aggregates.every(item => item.taskCount === 2)).toBe(true);
});

test('聚合兼容旧单SKU快照，products为权威且空数组不能回退旧字段', () => {
  const current = policy.parse(row()).rows[0];
  const { products, ...legacy } = current;
  expect(current).toMatchObject(products[0]);
  expect(policy.aggregate([legacy])).toEqual(policy.aggregate([current]));
  expect(policy.aggregate([{ ...legacy, products: [] }])).toEqual([]);
  expect(
    policy
      .aggregate([
        { ...legacy, products: [{ model: 'iPhone Duo', color: '夜空色', capacity: '2T' }] },
      ])
      .every(item => item.color === '夜空色' && item.capacity === '2T')
  ).toBe(true);
});

test('多SKU移除一款只令该款归零，其余分母不变', () => {
  const before = policy.parse(
    row('北京三里屯', 'iPhone Duo 星光白色 512G|iPhone Duo 夜空色 1T')
  ).aggregates;
  const after = policy.parse(row('北京三里屯')).aggregates;
  expect(policy.differences(before, after)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ color: '星光白色', capacity: '512G', delta: 0 }),
      expect.objectContaining({ color: '夜空色', capacity: '1T', nextCount: 0, delta: -1 }),
    ])
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
