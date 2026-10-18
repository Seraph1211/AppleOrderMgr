const { randomUUID } = require('crypto');
const policy = require('../src/services/aosSignalPolicy');
const now = Date.parse('2026-10-19T00:00:00.000Z');
const scope = { deviceId: randomUUID(), localId: randomUUID(), fileId: randomUUID() };
const line = (text, offset, extra = {}) =>
  policy.parseEntry(
    {
      id: randomUUID(),
      ...scope,
      byteOffset: offset,
      loggedAt: new Date(now).toISOString(),
      partIndex: 0,
      parseState: 'parsed',
      message: `2026-10-19 08:00:00.000 [2][013]A77-${text}\r\n`,
      ...extra,
    },
    now
  );

test('精确锚点和常见商品预约语法，持久化结果不包含账号及原文', () => {
  const entries = [
    line('消息20110501', 1),
    line('尝试预约: Apple 王府井, 2026-10-25, 25-19:00', 2),
    line('商品: iPhone Duo 512GB 星光白色 x 1, RMB 17,999', 3),
  ];
  const anchor = line('取货信息: 取货日期待付款完成后确定。(2026-10-24/0/Y)', 4);
  const context = policy.mergeContext(
    null,
    entries,
    { key: 's1', server: 'US09', instance: '心蓝11' },
    now
  );
  const value = policy.observation(context, anchor);
  expect(value).toMatchObject({
    city: '北京',
    storeName: 'Apple 王府井',
    model: 'iPhone Duo',
    color: '星光白色',
    capacity: '512G',
  });
  expect(JSON.stringify(entries)).not.toMatch(/013|A77|尝试预约|RMB/);
  expect(line('取货信息：取货日期待付款完成后确定', 5).kind).toBe('anchor');
});

test('未来、过期、异常编码、续行及缺失完整任务身份不触发', () => {
  for (const extra of [
    { loggedAt: new Date(now - 180001).toISOString() },
    { loggedAt: new Date(now + 1).toISOString() },
    { parseState: 'encoding_error' },
    { partIndex: 1 },
    { message: '取货信息: 取货日期待付款完成后确定' },
  ])
    expect(line('取货信息: 取货日期待付款完成后确定', 1, extra)).toBeNull();
  expect(
    line('取货信息: 取货日期待付款完成后确定', 1, {
      loggedAt: new Date(now - 180000).toISOString(),
    })
  ).not.toBeNull();
});

test('跨批乱序按文件偏移关联，新一次stock/reset不能继承旧规格', () => {
  let context = policy.mergeContext(
    null,
    [line('消息20110501', 1), line('商品: iPhone Duo 512GB 星光白色 x 1, RMB 1', 2)],
    {},
    now
  );
  context = policy.mergeContext(context, [line('尝试预约: Apple 王府井, 日期', 3)], {}, now);
  expect(policy.observation(context, line('取货信息: 取货日期待付款完成后确定', 4)).model).toBe(
    'iPhone Duo'
  );
  context = policy.mergeContext(context, [line('加入购物车成功', 5)], {}, now);
  expect(policy.observation(context, line('取货信息: 取货日期待付款完成后确定', 8)).model).toBe(
    '未知'
  );
  context = policy.mergeContext(
    context,
    [
      line('商品: iPhone Duo 512GB 星光白色 x 1, RMB 1', 7),
      line('尝试预约: Apple 王府井, 日期', 6),
    ],
    {},
    now
  );
  expect(policy.observation(context, line('取货信息: 取货日期待付款完成后确定', 8)).city).toBe(
    '北京'
  );
  expect(
    line('消息20110501', 9, { message: '2026-10-19 08:00:00.000 [2][014]A77-消息20110501' }).taskKey
  ).not.toBe(line('消息20110501', 9).taskKey);
  expect(line('消息20110501', 9, { fileId: randomUUID() }).taskKey).not.toBe(
    line('消息20110501', 9).taskKey
  );
});

test('11实例全部来源在单条概览，长分组详情受控且计数非库存', () => {
  const groups = {};
  for (let i = 0; i < 150; i++)
    policy.addGroup(groups, {
      city: `城市${i}`,
      storeCode: `R${i}`,
      storeName: `门店${i}`,
      observedAt: now,
      model: 'iPhone Duo',
      color: '星光白色',
      capacity: '512G',
      source: {
        key: `s${i % 11}`,
        server: `US${String((i % 10) + 1).padStart(2, '0')}`,
        instance: `心蓝${String((i % 11) + 1).padStart(2, '0')}`,
      },
    });
  const text = policy.content(groups, false);
  expect(Buffer.byteLength(text)).toBeLessThan(1500);
  expect(text).toContain('非库存数量');
  expect(text).toContain('150次命中');
  for (let i = 1; i <= 11; i++) expect(text).toContain(`心蓝${String(i).padStart(2, '0')}`);
});

test('单片段多条标准记录分别保留时间和顺序，无时间续行与异常分段不触发', () => {
  const message = [
    '2026-10-19 08:00:00.000 [2][013]A77-消息20110501',
    '2026-10-19 08:00:00.001 [2][013]A77-尝试预约: Apple 王府井, 日期',
    '2026-10-19 08:00:00.002 [2][013]A77-商品: iPhone Duo 512GB 星光白色 x 1, RMB 1',
    '2026-10-19 08:00:00.003 [2][013]A77-取货信息: 取货日期待付款完成后确定',
    '取货信息: 取货日期待付款完成后确定',
  ].join('\r\n');
  const entries = policy.parseEntries(
    {
      ...scope,
      id: randomUUID(),
      byteOffset: 10,
      loggedAt: new Date(now).toISOString(),
      parseState: 'parsed',
      partIndex: 0,
      message,
    },
    now + 10
  );
  expect(entries.map(row => row.kind)).toEqual(['stock', 'booking', 'product', 'anchor']);
  expect(new Set(entries.map(row => row.id)).size).toBe(4);
  expect(entries[3].loggedAt - entries[0].loggedAt).toBe(3);
  const observation = policy.observation(policy.mergeContext(null, entries, {}, now), entries[3]);
  expect(observation).toMatchObject({ city: '北京', model: 'iPhone Duo', capacity: '512G' });
  expect(
    policy.parseEntries(
      {
        ...scope,
        id: randomUUID(),
        byteOffset: 10,
        loggedAt: new Date(now).toISOString(),
        parseState: 'continuation',
        partIndex: 1,
        message,
      },
      now + 10
    )
  ).toEqual([]);
});

test('11来源的100字标签仍一条有效概览，时间与每组来源对应', () => {
  const groups = {};
  for (let i = 1; i <= 11; i++)
    policy.addGroup(groups, {
      city: '北京',
      storeCode: 'R448',
      storeName: 'Apple 王府井',
      model: 'iPhone Duo',
      color: '星光白色',
      capacity: '512G',
      observedAt: now + i,
      source: {
        key: `s${i}`,
        server: `US${String(((i - 1) % 10) + 1).padStart(2, '0')}`,
        instance: `心蓝${String(i).padStart(2, '0')}${'长'.repeat(96)}`,
      },
    });
  const text = policy.content(groups, false);
  expect(Buffer.byteLength(text)).toBeLessThan(1500);
  expect(text).toContain('日志时间（北京）：2026-10-19 08:00:00.001～2026-10-19 08:00:00.011');
  expect(text).toContain('S1×1');
  expect(text).toContain('S11×1');
  for (let i = 1; i <= 11; i++) expect(text).toContain(`心蓝${String(i).padStart(2, '0')}`);
});
