const service = require('../src/services/aosTaskRatioService');
const policy = require('../src/services/aosTaskConfigPolicy');
const content = require('../src/services/aosAccountRatioContent');
const item = {
  city: '广州',
  model: 'iPhone Duo',
  color: '星光白色',
  capacity: '512G',
  source: { key: 'dev:local', server: 'US_01', instance: '1号实例' },
};
const now = Date.parse('2026-10-28T12:00:00+08:00');
const ref = (accountNumber = '001', time = now) => ({
  anchor: { deviceId: 'dev', localId: 'local', fileId: 'file', accountNumber, loggedAt: time },
  item,
});
const version = (overrides = {}) => ({
  id: 'version-1',
  effectiveAt: new Date(now - 10000),
  effectiveTo: null,
  aggregates: [{ ...item, taskCount: 3 }],
  ...overrides,
});
const models = versions => ({
  MonitorInstance: { findOne: jest.fn().mockResolvedValue({ id: 'instance' }) },
  AosTaskConfigVersion: { findAll: jest.fn().mockResolvedValue(versions) },
});
const resultOf = result => result.scopes[policy.scopeKey(item)].sources['dev:local'];

test('同任务重复命中只计1，001和1保持不同，分母直接读上传统计', async () => {
  const result = await service.evaluate({ refs: [ref(), ref(), ref('1')] }, models([version()]));
  expect(resultOf(result)).toMatchObject({
    numerator: 2,
    denominator: 3,
    versionId: 'version-1',
    reason: null,
  });
});

test('一行五SKU解析后每个选中规格通知分母均1，未选规格局部省略比例', async () => {
  const fields = Array(36).fill('');
  [fields[0], fields[1], fields[2], fields[3], fields[4]] = [
    'synthetic@example.invalid',
    'SyntheticOnly',
    '上海浦东|上海静安',
    [
      'iPhone Duo 星光白色 512G',
      'iPhone Duo 星光白色 2T',
      'iPhone Duo 夜空色 2T',
      'iPhone Duo 星光白色 1T',
      'iPhone Duo 夜空色 1T',
    ].join('|'),
    '2',
  ];
  const parsed = policy.parse(fields.join(','));
  expect(parsed).toMatchObject({ valid: true, taskCount: 1, specCount: 5 });
  const selected = parsed.rows[0].products.map(product => ({
    ...item,
    ...product,
    city: '上海',
  }));
  const unselected = { ...item, city: '上海', color: '夜空色', capacity: '512G' };
  const tracker = {
    refs: [...selected, unselected].map(scope => ({ ...ref(), item: scope })),
  };
  const result = await service.evaluate(
    tracker,
    models([version({ aggregates: parsed.aggregates })])
  );
  for (const scope of selected) {
    expect(result.scopes[policy.scopeKey(scope)].sources['dev:local']).toMatchObject({
      numerator: 1,
      denominator: 1,
      reason: null,
    });
  }
  expect(result.scopes[policy.scopeKey(unselected)].sources['dev:local']).toMatchObject({
    numerator: null,
    denominator: null,
    reason: 'TASK_CONFIG_MISMATCH',
  });
  expect(tracker.refs).toHaveLength(6);
});

test.each([
  ['没有配置', [], [ref()], 'TASK_CONFIG_MISSING'],
  [
    '配置未来生效',
    [version({ effectiveAt: new Date(now + 1) })],
    [ref()],
    'TASK_CONFIG_CHANGED_DURING_WINDOW',
  ],
  [
    '配置窗口中途失效',
    [version({ effectiveTo: new Date(now + 1) })],
    [ref(), ref('002', now + 2)],
    'TASK_CONFIG_CHANGED_DURING_WINDOW',
  ],
  ['任务号未知', [version()], [ref(null)], 'TASK_IDENTITY_UNKNOWN'],
  [
    '分母少于分子',
    [version({ aggregates: [{ ...item, taskCount: 1 }] })],
    [ref(), ref('2')],
    'TASK_CONFIG_MISMATCH',
  ],
  [
    '跨文件编号可能重置',
    [version()],
    [ref(), { ...ref(), anchor: { ...ref().anchor, fileId: 'other' } }],
    'TASK_IDENTITY_CROSSES_FILES',
  ],
])('%s局部省略比例', async (_name, versions, refs, reason) => {
  expect(resultOf(await service.evaluate({ refs }, models(versions)))).toMatchObject({
    numerator: null,
    denominator: null,
    reason,
  });
});

test('配置读取失败只降级本来源，不阻塞信号', async () => {
  const db = models([]);
  db.AosTaskConfigVersion.findAll.mockRejectedValue(new Error('database secret fixture'));
  expect(resultOf(await service.evaluate({ refs: [ref()] }, db))).toMatchObject({
    reason: 'TASK_CONFIG_READ_FAILED',
  });
});

test('冻结快照后配置版本被回溯改变，省略比例而不改写旧值', async () => {
  const tracker = { refs: [ref()] };
  await service.evaluate(tracker, models([version()]));
  expect(
    resultOf(await service.evaluate(tracker, models([version({ id: 'version-2' })])))
  ).toMatchObject({ reason: 'TASK_FROZEN_VERSION_CHANGED' });
  expect(Object.values(tracker.taskSnapshots)[0].versionId).toBe('version-1');
});

test('消息明确同城任务；缺分母只保留命中，不出现残缺分数或诊断', async () => {
  const groups = {
    one: {
      ...item,
      storeCode: 'R639',
      storeName: 'Apple 天环广场',
      count: 4,
      firstAt: now,
      lastAt: now,
      sources: { 'dev:local': { ...item.source, count: 4 } },
    },
  };
  const good = content.formatSummary(
    groups,
    await service.evaluate({ refs: [ref()] }, models([version()]))
  );
  expect(good).toContain('1/—/3');
  const missing = content.formatSummary(
    groups,
    await service.evaluate({ refs: [ref()] }, models([]))
  );
  expect(missing).toContain('1号实例｜4次命中');
  expect(missing).not.toMatch(/\/—|完整性|TASK_CONFIG/);
});

test('旧pending没有关联引用也升级任务格式，不保留N/—', async () => {
  const AosSignalService = require('../src/services/aosSignalService');
  const groups = {
    one: {
      ...item,
      storeCode: 'R639',
      storeName: 'Apple 天环广场',
      count: 4,
      firstAt: now,
      lastAt: now,
      sources: { 'dev:local': { ...item.source, count: 4 } },
    },
  };
  const old = {
    id: 'delivery',
    kind: 'aos_signal',
    status: 'pending',
    aosImmediate: false,
    aosGroups: groups,
    aosAccountRatio: { version: 1, scopes: {} },
    content: 'old 1/—',
  };
  const owner = { m: models([]), put: jest.fn().mockResolvedValue(null) };
  const service = new AosSignalService(owner);
  const result = await service.reconcile({ state: {}, transaction: null }, [old]);
  expect(result[0].aosAccountRatio.version).toBe(3);
  expect(result[0].content).toContain('4次命中');
  expect(result[0].content).not.toContain('/—');
  expect(owner.put).toHaveBeenCalled();
});

test('总查询预算耗尽后不再读取后续来源，已完成比例与原始命中保留', async () => {
  let elapsed = 0;
  const db = models([version()]);
  db.AosTaskConfigVersion.findAll.mockImplementation(() => {
    elapsed += service.READ_BUDGET_MS;
    return Promise.resolve([version()]);
  });
  const secondItem = {
    ...item,
    source: { key: 'second:local', server: 'US_02', instance: '2号实例' },
  };
  const tracker = {
    refs: [ref(), { anchor: { ...ref().anchor, deviceId: 'second' }, item: secondItem }],
  };
  const result = await service.evaluate(tracker, db, null, { monotonicNow: () => elapsed });
  const sources = result.scopes[policy.scopeKey(item)].sources;
  expect(sources['dev:local']).toMatchObject({ numerator: 1, denominator: 3, reason: null });
  expect(sources['second:local']).toMatchObject({
    numerator: null,
    denominator: null,
    reason: 'TASK_CONFIG_READ_BUDGET',
  });
  expect(db.MonitorInstance.findOne).toHaveBeenCalledTimes(1);
  expect(db.AosTaskConfigVersion.findAll).toHaveBeenCalledTimes(1);
  const groups = {
    one: {
      ...item,
      storeCode: 'R639',
      storeName: 'Apple 天环广场',
      count: 7,
      firstAt: now,
      lastAt: now,
      sources: {
        'dev:local': { ...item.source, count: 3 },
        'second:local': { ...secondItem.source, count: 4 },
      },
    },
  };
  const text = content.formatSummary(groups, result);
  expect(text).toContain('7次命中');
  expect(text).toContain('1号实例｜1/—/3');
  expect(text).toContain('2号实例｜4次命中');
  expect(tracker.refs).toHaveLength(2);
});

test('来源身份查询耗尽预算后不再发起该来源的版本查询', async () => {
  let elapsed = 0;
  const db = models([version()]);
  db.MonitorInstance.findOne.mockImplementation(() => {
    elapsed += service.READ_BUDGET_MS;
    return Promise.resolve({ id: 'instance' });
  });
  const result = await service.evaluate({ refs: [ref()] }, db, null, {
    monotonicNow: () => elapsed,
  });
  expect(resultOf(result)).toMatchObject({ reason: 'TASK_CONFIG_READ_BUDGET' });
  expect(db.AosTaskConfigVersion.findAll).not.toHaveBeenCalled();
});
