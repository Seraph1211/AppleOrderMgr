/* eslint-disable no-magic-numbers */
const stock = require('../src/services/aosStockTaskPolicy');
const signals = require('../src/services/aosSignalPolicy');
const ratios = require('../src/services/aosTaskRatioService');
const config = require('../src/services/aosTaskConfigPolicy');
const formatter = require('../src/services/aosAccountRatioContent');
const at = Date.parse('2026-10-29T17:41:00+08:00');
const source = { key: 'dev:local', server: 'US_01', instance: '01号实例', enabled: true };
const scope = { city: '上海', model: 'iPhone Duo', color: '星光白色', capacity: '512G', source };
const event = (kind, offset, accountNumber = '001', fields = {}) => ({
  id: `${accountNumber}:${offset}`,
  kind,
  byteOffset: String(offset),
  lineIndex: 0,
  deviceId: 'dev',
  localId: 'local',
  fileId: 'file',
  taskKey: `task:${accountNumber}`,
  loggedAt: at + offset,
  receivedAt: at + offset,
  accountNumber,
  ...fields,
});
const attempt = (accountNumber = '001', offset = 10) => [
  event('stock', offset, accountNumber),
  event('booking', offset + 1, accountNumber, {
    city: '上海',
    storeCode: 'R401',
    storeName: 'Apple 南京东路',
  }),
  event('product', offset + 2, accountNumber, scope),
];
function buffer(entries, previous = null, now = at) {
  const contexts = new Map();
  for (const row of entries) {
    const context = contexts.get(row.taskKey) || { source, events: [] };
    context.events.push(row);
    contexts.set(row.taskKey, context);
  }
  return stock.collect(previous, entries, contexts, now, at - 1000);
}
const group = { scope, refs: [{ anchor: event('anchor', 20), item: scope }] };
const count = snapshot => stock.count(snapshot, group, new Set(['001']), 45);
const db = () => ({
  MonitorInstance: { findOne: jest.fn().mockResolvedValue({ id: 'instance' }) },
  AosTaskConfigVersion: {
    findAll: jest.fn().mockResolvedValue([
      {
        id: 'v1',
        effectiveAt: new Date(at - 1000),
        effectiveTo: null,
        aggregates: [{ ...scope, taskCount: 45 }],
      },
    ]),
  },
});

test('独立收集20个有货任务，9个提交11次命中保持9/20/45，001与1不同', async () => {
  const entries = Array.from({ length: 20 }, (_, i) => attempt(String(i).padStart(3, '0'))).flat();
  const b = buffer(entries);
  const refs = Array.from({ length: 9 }, (_, i) => ({
    ...group.refs[0],
    anchor: event('anchor', 20, String(i).padStart(3, '0')),
  }));
  const tracker = { refs: [...refs, refs[0], refs[1]] };
  tracker.stock = stock.snapshot(b, tracker, at, at + 180000);
  const result = await ratios.evaluate(tracker, db());
  expect(result.scopes[config.scopeKey(scope)].sources[source.key]).toMatchObject({
    numerator: 9,
    stockCount: 20,
    denominator: 45,
    stockReason: null,
  });
  const groups = signals.addGroup(
    {},
    { ...scope, storeCode: 'R401', storeName: 'Apple 南京东路', observedAt: at }
  );
  groups[Object.keys(groups)[0]].count = 11;
  const text = formatter.formatSummary(groups, result);
  expect(text).toContain('3分钟汇总｜11次命中｜1家门店');
  expect(text).toContain('US_01 / 01号实例｜9/20/45');
  expect(text.endsWith('\n')).toBe(false);
});

test('同任务重复检测、同城多店只计1；未提交任务仍进入有货数', () => {
  const entries = [...attempt(), ...attempt('001', 30), ...attempt('1', 10)];
  entries[4] = { ...entries[4], storeCode: 'R359', storeName: 'Apple 上海环贸 iapm' };
  const b = buffer(entries);
  expect(count(stock.snapshot(b, { refs: group.refs }, at, at + 180000))).toMatchObject({
    stockCount: 2,
    stockAccounts: ['001', '1'],
    stockReason: null,
  });
});

test('同任务最近明确单规格单城市配置可证明检测，失败无需后续商品或提交', () => {
  const entries = [
    event('configStart', 1, '001', scope),
    event('configCity', 2, '001', { cities: ['上海'], unknown: false }),
    event('stock', 10),
  ];
  const b = buffer(entries);
  expect(count(stock.snapshot(b, { refs: group.refs }, at, at + 100))).toMatchObject({
    stockCount: 1,
  });
});

test('最新启动不完整不能借旧配置；检测后的未来启动不能补过去', () => {
  const b = buffer([
    event('configStart', 1, '001', scope),
    event('configCity', 2, '001', { cities: ['上海'], unknown: false }),
    event('configStart', 3),
    event('stock', 10),
    event('configStart', 11, '001', scope),
    event('configCity', 12, '001', { cities: ['上海'], unknown: false }),
  ]);
  expect(count(stock.snapshot(b, { refs: group.refs }, at, at + 100))).toMatchObject({
    stockCount: null,
    stockReason: 'STOCK_SCOPE_UNKNOWN',
  });
});

test.each(['reset', 'stock', 'configStart'])('%s隔开尝试，不借用后轮商品或门店', kind => {
  const b = buffer([event('stock', 10), event(kind, 11), ...attempt('001', 20).slice(1)]);
  const first = b.refs.find(ref => ref.anchor.byteOffset === '10');
  expect(first.reason).toBe('STOCK_SCOPE_UNKNOWN');
});

test('未知维度可能属于该范围时不能静默丢弃成0；明确不同规格可以排除', () => {
  const b = buffer([...attempt(), event('stock', 50, '002')]);
  expect(count(stock.snapshot(b, { refs: group.refs }, at, at + 100)).stockCount).toBeNull();
  const other = buffer([
    ...attempt(),
    ...attempt('002', 50).map(row => (row.kind === 'product' ? { ...row, capacity: '1T' } : row)),
  ]);
  expect(count(stock.snapshot(other, { refs: group.refs }, at, at + 100)).stockCount).toBe(1);
});

test('首窗纳入提交前检测及同段未提交任务，后续半开窗口不重复累计', () => {
  const b = buffer([...attempt(), ...attempt('002', 11), ...attempt('003', 100)]);
  const first = stock.snapshot(b, { refs: group.refs }, at + 20, at + 100, true);
  expect(first.from).toBe(at + 10);
  expect(count(first).stockCount).toBe(2);
  const next = stock.snapshot(b, { refs: [] }, at + 100, at + 200);
  expect(next.refs.map(ref => ref.anchor.accountNumber)).toEqual(['003']);
});

test('跨上传批次、JSON恢复、上下文截尾保留已证明数据；重复上传不加数', () => {
  const start = attempt();
  let b = buffer(start.slice(0, 1));
  b = JSON.parse(JSON.stringify(b));
  b = buffer(start, b, at + 15);
  b = stock.collect(b, [], new Map(), at + 30, at - 1000);
  expect(count(stock.snapshot(b, { refs: group.refs }, at, at + 100)).stockCount).toBe(1);
  expect(b.refs).toHaveLength(1);
});

test('有货不得由提交反推；缺跟踪、预热、溢出、跨文件均不伪造数值', () => {
  expect(count(undefined).stockReason).toBe('STOCK_TRACKER_MISSING');
  const empty = stock.snapshot(buffer([]), {}, at, at + 100);
  expect(count(empty).stockReason).toBe('STOCK_SUBMISSION_NOT_OBSERVED');
  const b = buffer(attempt());
  expect(
    count(stock.snapshot({ ...b, startedAt: at + 50 }, {}, at, at + 100)).stockCount
  ).toBeNull();
  expect(count(stock.snapshot({ ...b, overflowAt: at + 20 }, {}, at, at + 100)).stockReason).toBe(
    'STOCK_REFERENCE_LIMIT'
  );
  const cross = buffer([...attempt(), ...attempt('002').map(row => ({ ...row, fileId: 'other' }))]);
  expect(count(stock.snapshot(cross, {}, at, at + 100)).stockReason).toBe(
    'STOCK_IDENTITY_CROSSES_FILES'
  );
});

test('有货超过配置数，保留已知提交/分母，中间未知；长文本仍在字节预算内', async () => {
  const tracker = {
    refs: group.refs,
    stock: stock.snapshot(buffer([...attempt(), ...attempt('002')]), {}, at, at + 100),
  };
  const models = db();
  models.AosTaskConfigVersion.findAll.mockResolvedValue([
    {
      id: 'v1',
      effectiveAt: new Date(at - 1000),
      effectiveTo: null,
      aggregates: [{ ...scope, taskCount: 1 }],
    },
  ]);
  const result = await ratios.evaluate(tracker, models);
  expect(result.scopes[config.scopeKey(scope)].sources[source.key]).toMatchObject({
    numerator: 1,
    stockCount: null,
    denominator: 1,
    stockReason: 'STOCK_CONFIG_MISMATCH',
  });
});

test('检测与提交跨越配置版本时不能用后生效版本补检测', async () => {
  const tracker = { refs: group.refs, stock: stock.snapshot(buffer(attempt()), {}, at, at + 100) };
  const models = db();
  models.AosTaskConfigVersion.findAll.mockResolvedValue([
    {
      id: 'later',
      effectiveAt: new Date(at + 15),
      effectiveTo: null,
      aggregates: [{ ...scope, taskCount: 45 }],
    },
  ]);
  expect(
    (await ratios.evaluate(tracker, models)).scopes[config.scopeKey(scope)].sources[source.key]
  ).toMatchObject({
    numerator: 1,
    denominator: 45,
    stockCount: null,
    stockReason: 'STOCK_CONFIG_CHANGED_DURING_WINDOW',
  });
});

test('同范围另一实例只检测未提交，也显示0/N/D，原提交命中总数不变', async () => {
  const entries = [
    ...attempt(),
    ...attempt('002').map(row => ({ ...row, deviceId: 'other', taskKey: 'other-task' })),
  ];
  const contexts = new Map([
    ['task:001', { source, events: entries.slice(0, 3) }],
    [
      'other-task',
      {
        source: { ...source, key: 'other:local', server: 'US_02', instance: '02号实例' },
        events: entries.slice(3),
      },
    ],
  ]);
  const b = stock.collect(null, entries, contexts, at, at - 1000);
  const tracker = { refs: group.refs, stock: stock.snapshot(b, {}, at, at + 100) };
  const result = await ratios.evaluate(tracker, db());
  const groups = signals.addGroup(
    {},
    { ...scope, storeCode: 'R401', storeName: 'Apple 南京东路', observedAt: at }
  );
  const text = formatter.formatSummary(groups, result);
  expect(text).toContain('1次命中｜1家门店');
  expect(text).toContain('US_02 / 02号实例｜0/1/45');
});

test('只匹配独立有货消息码，拒绝相似码及错误文本，保留日志任务前导零', () => {
  const parse = text =>
    signals.parseEntry(
      {
        id: 'x',
        deviceId: 'dev',
        localId: 'local',
        fileId: 'file',
        byteOffset: 1,
        loggedAt: new Date(at).toISOString(),
        parseState: 'parsed',
        partIndex: 0,
        message: `2026-10-29 17:41:00.000 [2][001]A-${text}`,
      },
      at
    );
  expect(parse('消息20110501')).toMatchObject({ kind: 'stock', accountNumber: '001' });
  expect(parse('消息201105010')).toBeNull();
  expect(parse('失败：消息20110501')).toBeNull();
});

test('设置证据长期保存且最新启动清空旧城市，JSON不含日志原文及凭据', () => {
  const entries = [
    event('configStart', 1, '001', { ...scope, message: 'must-not-store' }),
    event('configCity', 2, '001', { cities: ['上海'], unknown: false }),
  ];
  const context = signals.mergeContext(null, entries, source, at);
  const truncated = signals.mergeContext(
    context,
    Array.from({ length: 110 }, (_, i) => event('reset', i + 100)),
    source,
    at
  );
  expect(truncated.configuration[0].model).toBe('iPhone Duo');
  expect(JSON.stringify(truncated.configuration)).not.toContain('must-not-store');
  expect(stock.configuration(truncated, [event('configStart', 500)]).at(-1).kind).toBe(
    'configStart'
  );
  const b = buffer([
    ...stock.configuration(truncated, [event('configStart', 500)]),
    event('stock', 501),
  ]);
  expect(b.refs[0].reason).toBe('STOCK_SCOPE_UNKNOWN');
});

test('现有真实脱敏样本的独立20110501日志可解析，位置在同任务预约/商品之前', () => {
  const fixture = require('./aosSignalIndependentFixture.json');
  const parsed = fixture.flatMap(row => signals.parseEntries(row, Date.parse(row.loggedAt)));
  const stocks = parsed.filter(row => row.kind === 'stock');
  expect(stocks.length).toBeGreaterThan(0);
  expect(
    stocks.some(hit =>
      parsed.some(
        row =>
          row.taskKey === hit.taskKey &&
          row.kind === 'booking' &&
          BigInt(row.byteOffset) > BigInt(hit.byteOffset)
      )
    )
  ).toBe(true);
  expect(stocks.every(hit => /^\d+$/.test(hit.accountNumber))).toBe(true);
});

test('首窗不越过已结算窗口，独立未提交的前置检测也计入新轮', () => {
  const b = buffer([...attempt('002', 5), ...attempt('001', 10)]);
  const full = stock.snapshot(b, { refs: group.refs }, at + 20, at + 100, true);
  expect(count(full).stockCount).toBe(2);
  const closed = stock.snapshot(
    { ...b, closedUntil: at + 8 },
    { refs: group.refs },
    at + 20,
    at + 100,
    true
  );
  expect(count(closed).stockCount).toBe(1);
});

test('重复预约压缩为城市语义证据，不因原始条数超限丢失商品', () => {
  const entries = [
    event('stock', 1),
    ...Array.from({ length: 20 }, (_, i) => event('booking', i + 2, '001', { city: '上海' })),
    event('product', 30, '001', scope),
  ];
  let b = buffer(entries);
  expect(b.refs[0].reason).toBeNull();
  b = stock.collect(
    b,
    [],
    new Map([[entries[0].taskKey, { source, events: [] }]]),
    at + 50,
    at - 1000
  );
  expect(b.refs[0].reason).toBeNull();
});

test('超限丢弃前后两段不能只保留最后时刻，影响旧窗口时依然未知', () => {
  const b = { ...buffer(attempt()), overflowFrom: at + 20, overflowAt: at + 150 };
  expect(count(stock.snapshot(b, {}, at, at + 100)).stockReason).toBe('STOCK_REFERENCE_LIMIT');
});

test('运行态超限、旧水位与过期观察有界清理，不把旧检测带到重新启用', () => {
  const refs = Array.from({ length: stock.MAX_REFS }, (_, i) => ({
    anchor: event('stock', i + 1),
    item: scope,
    evidence: [],
    reason: null,
  }));
  const previous = { version: 1, since: at - 1000, startedAt: at - 1000, refs };
  const row = event('stock', 50000);
  const contexts = new Map([[row.taskKey, { source, events: [row] }]]);
  const full = stock.collect(previous, [row], contexts, at + 50000, at - 1000);
  expect(full.refs).toHaveLength(stock.MAX_REFS);
  expect(full.overflowAt).toBe(row.receivedAt);
  expect(stock.collect(full, [], new Map(), at + 50000, at + 1).refs).toHaveLength(0);
  expect(stock.collect(full, [], new Map(), at + 600000, at - 1000).refs).toHaveLength(0);
});

test('待发窗口冻结证据不因六分钟运行态TTL丢失，未提交任务不被静默扣减', () => {
  const original = buffer([...attempt(), ...attempt('002')]);
  const frozen = stock.snapshot(original, { refs: group.refs }, at + 20, at + 180000, true);
  const cleaned = {
    ...original,
    refs: original.refs.filter(ref => ref.anchor.accountNumber !== '002'),
  };
  const refreshed = stock.refreshSnapshot(frozen, cleaned, new Map());
  expect(count(refreshed)).toMatchObject({ stockCount: 2, stockReason: null });
  expect(frozen.refs).toHaveLength(2);
  expect(count(stock.refreshSnapshot(frozen, null, new Map())).stockCount).toBe(2);
});

test('冻结有货尝试仍按晚到重启边界复核，不能因保留快照借用下一轮商品', () => {
  const original = buffer(attempt());
  const frozen = stock.snapshot(original, {}, at, at + 100);
  const late = event('reset', 11);
  const refreshed = stock.refreshSnapshot(
    frozen,
    { ...original, refs: [] },
    new Map([[late.taskKey, { source, events: [late] }]])
  );
  expect(count(refreshed)).toMatchObject({ stockCount: null, stockReason: 'STOCK_SCOPE_UNKNOWN' });
});

test('同次有货后的24093001单城市响应可证明失败任务，跨城冲突与下轮响应仍未知', () => {
  const setup = event('configStart', 1, '001', scope);
  const hit = event('stock', 10);
  const response = event('configCity', 11, '001', { response: true, cities: ['上海'] });
  expect(buffer([setup, hit, response]).refs[0]).toMatchObject({
    reason: null,
    item: { city: '上海' },
  });
  const conflict = event('configCity', 12, '001', { response: true, cities: ['天津'] });
  expect(buffer([setup, hit, response, conflict]).refs[0].reason).toBe('STOCK_SCOPE_UNKNOWN');
  expect(
    buffer([setup, hit, event('reset', 11), { ...response, id: 'late-response', byteOffset: '12' }])
      .refs[0].reason
  ).toBe('STOCK_SCOPE_UNKNOWN');
});

test('大量相同预约不挤出语义商品，跨批次晚到边界仍撤销后轮归属', () => {
  const all = [
    event('stock', 10),
    ...Array.from({ length: 150 }, (_, i) => event('booking', i + 20, '001', { city: '上海' })),
    event('product', 200, '001', scope),
  ];
  const context = signals.mergeContext(null, all, source, at);
  let b = stock.collect(null, all, new Map([[all[0].taskKey, context]]), at, at - 1000);
  expect(b.refs[0].reason).toBeNull();
  const boundary = event('reset', 15);
  const refreshed = signals.mergeContext(context, [boundary], source, at);
  b = stock.collect(b, [], new Map([[all[0].taskKey, refreshed]]), at, at - 1000);
  expect(b.refs[0].reason).toBe('STOCK_SCOPE_UNKNOWN');
});

test('真正不同语义超限的缺口在JSON恢复及后续截尾仍保留', () => {
  const all = [
    event('stock', 1),
    ...Array.from({ length: 20 }, (_, i) => event('booking', i + 2, '001', { city: `城市${i}` })),
    event('product', 30, '001', scope),
  ];
  let b = buffer(all);
  expect(b.refs[0].reason).toBe('STOCK_EVIDENCE_LIMIT');
  b = stock.collect(
    JSON.parse(JSON.stringify(b)),
    [],
    new Map([[all[0].taskKey, { source, events: [] }]]),
    at,
    at - 1000
  );
  expect(b.refs[0].reason).toBe('STOCK_EVIDENCE_LIMIT');
});
