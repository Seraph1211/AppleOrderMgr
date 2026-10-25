/* eslint-disable no-magic-numbers */
const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const configPolicy = require('../src/services/aosAccountConfigPolicy');
const fixture = require('./fixtures/aosAccountRatioRealSample.json');
const legacyApi = require('./fixtures/aosAccountRatioLegacyApi.json');
const signalPolicy = require('../src/services/aosSignalPolicy');
const ratioContent = require('../src/services/aosAccountRatioContent');
const accountRatios = require('../src/services/aosAccountRatioService');

const DEVICE = '11111111-1111-4111-8111-111111111111';
const INSTANCE = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-10-25T20:45:24.233+08:00');
const SCOPE = { city: '广州', model: 'iPhone Duo', color: '星光白色', capacity: '512G' };
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value =>
  [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32),
  ].join('-');

/** 构造不含AppleID/代理/联系人字段的标准片段。 */
function row(text, options = {}) {
  const at = options.at ?? NOW - 3600000;
  const account = options.account ?? '001';
  const stamp = new Date(at + 8 * 3600000).toISOString().slice(0, 23).replace('T', ' ');
  return {
    id: options.id || randomUUID(),
    deviceId: options.deviceId || DEVICE,
    localId: options.localId || INSTANCE,
    fileId: options.fileId || FILE,
    byteOffset: options.offset ?? 10,
    loggedAt: new Date(at).toISOString(),
    accountNumber: options.metadataAccount ?? account,
    parseState: 'parsed',
    partIndex: 0,
    message: `${stamp} [2][${account}]${options.task ? `${options.task}-` : ''}${text}\r\n`,
  };
}

/** 真实受限采样回放：仅startup原安全行和门店白名单token，不含其他原文。 */
function realInputs() {
  const events = fixture.events.map(event => ({
    id: uuid(event.idHash),
    deviceId: DEVICE,
    localId: INSTANCE,
    fileId: uuid(event.fileHash),
    byteOffset: event.offset,
    loggedAt: event.at,
    accountNumber: event.account,
    parseState: 'parsed',
    partIndex: 0,
    message: event.message,
  }));
  const anchors = fixture.anchors.map(anchor =>
    row('取货信息: 取货日期待付款完成后确定', {
      id: uuid(anchor.idHash),
      account: anchor.account,
      at: Date.parse(anchor.at),
      fileId: uuid(anchor.fileHash),
      offset: anchor.offset,
      task: anchor.taskToken,
    })
  );
  return [...events, ...anchors];
}

test('冻结旧API源码hash严格匹配，真实旧parser确实不会附带accountNumber', () => {
  expect(hash(legacyApi.policySource)).toBe(legacyApi.policySha256);
  expect(hash(legacyApi.enqueueSource)).toBe(legacyApi.enqueueSha256);
  const module = { exports: {} };
  const dependencies = createRequire(require.resolve('../src/services/aosSignalPolicy'));
  vm.runInNewContext(
    legacyApi.policySource,
    { module, require: dependencies, Buffer, structuredClone },
    { filename: 'frozen-legacy-aos-api-policy.js' }
  );
  const input = row('取货信息: 取货日期待付款完成后确定', { at: NOW - 1, task: 'A337' });
  const parsed = module.exports.parseEntries(input, NOW);
  expect(parsed).toHaveLength(1);
  expect(parsed[0].kind).toBe('anchor');
  expect(parsed[0].accountNumber).toBeUndefined();
  expect(parsed[0].id).toBe(input.id);
});

test('受限真实fixture来源可核对：336startup/setting原行哈希及10个A任务映射真实匹配', () => {
  expect(fixture.events).toHaveLength(1007);
  expect(new Set(fixture.events.map(event => event.account)).size).toBe(336);
  expect(fixture.events.filter(event => event.kind === 'start')).toHaveLength(336);
  expect(fixture.events.filter(event => event.kind === 'setting')).toHaveLength(336);
  for (const event of fixture.events.filter(event => ['start', 'setting'].includes(event.kind))) {
    expect(hash(event.message)).toBe(event.rawLineHash);
    expect(event.task).toBeNull();
    expect(event.message).not.toMatch(/A\d+-/);
  }
  for (const anchor of fixture.anchors) {
    expect(anchor.taskToken).toMatch(/^A\d+$/);
    expect(hash(`[2][${anchor.account}]${anchor.taskToken}`)).toBe(anchor.taskHash);
    expect(anchor.taskMatchedToStartupStoreEvidence).toBe(true);
  }
  expect(JSON.stringify(fixture)).not.toMatch(/https?:|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);
});

test('真实336编号经新parser/resolver完整回放得到广州10/23，未知038不污染白512', () => {
  const parsed = configPolicy.parse(realInputs());
  expect(parsed.accounts).toHaveLength(336);
  expect(
    parsed.events.filter(event => event.kind === 'start' && event.body.mode === 'monitor')
  ).toHaveLength(336);
  expect(
    parsed.events.filter(event => event.kind === 'start' && event.body.mode === 'order')
  ).toHaveLength(336);
  expect(parsed.events.filter(event => event.kind === 'city')).toHaveLength(335);
  expect(parsed.events.filter(event => event.kind === 'signal')).toHaveLength(10);
  const result = configPolicy.population(parsed.accounts, parsed.events, SCOPE, NOW);
  expect(result.complete).toBe(true);
  expect(result.unknownAccounts).toEqual([]);
  expect(result.members).toEqual(
    Array.from({ length: 23 }, (_, index) => String(index + 1).padStart(3, '0'))
  );
  expect(
    new Set(
      parsed.events.filter(event => event.kind === 'signal').map(event => event.accountNumber)
    ).size
  ).toBe(10);
  expect(
    configPolicy.population(parsed.accounts, parsed.events, { ...SCOPE, city: '深圳' }, NOW).members
  ).toHaveLength(26);
  expect(
    configPolicy.population(parsed.accounts, parsed.events, { ...SCOPE, city: '武汉' }, NOW).members
  ).toHaveLength(20);
  const unknown = configPolicy.resolveAccount(
    parsed.events.filter(event => event.accountNumber === '038'),
    NOW
  );
  expect(unknown).toMatchObject({ model: 'iPhone Duo', color: '夜空色', capacity: '1T' });
  expect(unknown.city).toBeUndefined();
  const night = configPolicy.population(
    parsed.accounts,
    parsed.events,
    { ...SCOPE, color: '夜空色', capacity: '1T' },
    NOW
  );
  expect(night.complete).toBe(false);
  expect(night.unknownAccounts).toEqual(['038']);
  const directory = process.env.AOS_RATIO_QA_EVIDENCE_DIR;
  if (directory) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'parser真实回放覆盖.json'),
      JSON.stringify(
        {
          accounts: parsed.accounts.length,
          starts: parsed.events.filter(
            event => event.kind === 'start' && event.body.mode === 'monitor'
          ).length,
          settings: parsed.events.filter(
            event => event.kind === 'start' && event.body.mode === 'order'
          ).length,
          cities: parsed.events.filter(event => event.kind === 'city').length,
          signals: parsed.events.filter(event => event.kind === 'signal').length,
          identityMatches: fixture.anchors.filter(
            anchor => hash(`[2][${anchor.account}]${anchor.taskToken}`) === anchor.taskHash
          ).length,
          ratio: `10/${result.members.length}`,
          unknownCity: ['038'],
          unknownTargetNight: night.unknownAccounts,
          fixtureSourceSha256: fixture.provenance.completeEvidenceSha256,
        },
        null,
        2
      )
    );
  }
});

test('长期设置不受近10分钟或24小时门槛影响，stop不改最近配置', () => {
  const rows = [
    row('开始监控库存状态......', { at: NOW - 3 * 86400000, offset: 1 }),
    row('开始下单 iPhone Duo 星光白色 512G(x1)....', { at: NOW - 3 * 86400000 + 1, offset: 2 }),
    row('消息24093001: R639, 2, , 0', { at: NOW - 3 * 86400000 + 2, offset: 3, task: 'A1' }),
    row('停止操作', { at: NOW - 1000, offset: 4 }),
  ];
  const parsed = configPolicy.parse(rows);
  expect(configPolicy.resolveAccount(parsed.events, NOW)).toMatchObject(SCOPE);
  expect(configPolicy.population(parsed.accounts, parsed.events, SCOPE, NOW).members).toEqual([
    '001',
  ]);
});

test('原始编号字符串保留，001/01/1不同且64位数字字符串不碰撞', () => {
  const numbers = ['001', '01', '1', '9'.repeat(64), `${'9'.repeat(63)}8`];
  const parsed = configPolicy.parse(
    numbers.flatMap(account => [
      row('开始下单 iPhone Duo 星光白色 512G(x1)....', { account, offset: 1 }),
      row('消息24093001: R639, 2, , 0', { account, offset: 2, task: 'A1' }),
    ])
  );
  expect(parsed.accounts.map(account => account.accountNumber).sort()).toEqual([...numbers].sort());
  expect(configPolicy.population(parsed.accounts, parsed.events, SCOPE, NOW).members).toEqual(
    [...numbers].sort()
  );
});

test('最近启动缺设置不能借上轮；无A头相同null不能证明同轮', () => {
  const parsed = configPolicy.parse([
    row('开始下单 iPhone Duo 星光白色 512G(x1)....', { at: NOW - 1000, offset: 1 }),
    row('消息24093001: R639, 2, , 0', { at: NOW - 999, offset: 2, task: 'A1' }),
    row('开始监控库存状态......', { at: NOW - 500, offset: 3 }),
  ]);
  const config = configPolicy.resolveAccount(parsed.events, NOW);
  expect(config.model).toBeUndefined();
  expect(config.city).toBeUndefined();
  expect(configPolicy.population(parsed.accounts, parsed.events, SCOPE, NOW).complete).toBe(false);
});

test('新配置未来才生效，不污染放货时点的旧as-of，已知规格不同可直接排除', () => {
  const parsed = configPolicy.parse([
    row('开始下单 iPhone Duo 星光白色 512G(x1)....', { at: NOW - 1000, offset: 1 }),
    row('消息24093001: R639, 2, , 0', { at: NOW - 999, offset: 2, task: 'A1' }),
    row('开始下单 iPhone Duo 夜空色 1T(x1)....', { at: NOW + 1, offset: 3 }),
  ]);
  expect(configPolicy.population(parsed.accounts, parsed.events, SCOPE, NOW).members).toEqual([
    '001',
  ]);
  const after = configPolicy.population(parsed.accounts, parsed.events, SCOPE, NOW + 1);
  expect(after.complete).toBe(true);
  expect(after.members).toEqual([]);
});

test('旧文件较晚city不能无可信边界嫁接到新文件startup', () => {
  const parsed = configPolicy.parse([
    row('开始下单 iPhone Duo 星光白色 512G(x1)....', { fileId: FILE, at: NOW - 1000, offset: 10 }),
    row('消息24093001: R639, 2, , 0', {
      fileId: '44444444-4444-4444-8444-444444444444',
      at: NOW - 999,
      offset: 9999,
      task: 'A1',
    }),
  ]);
  expect(configPolicy.resolveAccount(parsed.events, NOW).city).toBeUndefined();
  expect(configPolicy.population(parsed.accounts, parsed.events, SCOPE, NOW).complete).toBe(false);
});

test('同文件同毫秒按偏移判轮次，跨文件同刻启动有歧义', () => {
  const at = NOW - 1000;
  const parsed = configPolicy.parse([
    row('消息24093001: R639, 2, , 0', { at, offset: 1, task: 'A1' }),
    row('开始下单 iPhone Duo 星光白色 512G(x1)....', { at, offset: 2 }),
  ]);
  expect(configPolicy.resolveAccount(parsed.events, NOW).city).toBeUndefined();
  const other = configPolicy.parse([
    row('开始下单 iPhone Duo 星光白色 512G(x1)....', { at, offset: 1 }),
    row('开始下单 iPhone Duo 夜空色 1T(x1)....', {
      at,
      offset: 1,
      fileId: '44444444-4444-4444-8444-444444444444',
    }),
  ]);
  expect(configPolicy.resolveAccount(other.events, NOW).reason).toBe('AMBIGUOUS_FILE_BOUNDARY');
});

test('普通无货/登录状态不应抹去已证实城市；显式未知门店代码仍降未知', () => {
  const rows = [
    row('开始下单 iPhone Duo 星光白色 512G(x1)....', { at: NOW - 1000, offset: 1 }),
    row('消息24093001: R639, 2, , 0', { at: NOW - 999, offset: 2, task: 'A1' }),
    row('库存无货，继续查询', { at: NOW - 900, offset: 3, task: 'A1' }),
    row('登录失败，没有有货信息', { at: NOW - 800, offset: 4, task: 'A1' }),
  ];
  const parsed = configPolicy.parse(rows);
  expect(configPolicy.resolveAccount(parsed.events, NOW)).toMatchObject(SCOPE);
  const unknown = configPolicy.parse([
    ...rows,
    row('消息21101002: R_UNKNOWN, 2, , 0', { at: NOW - 700, offset: 5, task: 'A1' }),
  ]);
  expect(configPolicy.resolveAccount(unknown.events, NOW).city).toBeUndefined();
});

test('同城多门店仍属于同一分母，跨城市证据冲突保留未知', () => {
  const rows = [
    row('开始下单 iPhone Duo 星光白色 512G(x1)....', { at: NOW - 1000, offset: 1 }),
    row('消息24093001: R639, 2, , 0', { at: NOW - 999, offset: 2, task: 'A1' }),
    row('消息21101002: R577, 2, , 0', { at: NOW - 998, offset: 3, task: 'A1' }),
  ];
  const parsed = configPolicy.parse(rows);
  expect(configPolicy.population(parsed.accounts, parsed.events, SCOPE, NOW).members).toEqual([
    '001',
  ]);
  const conflict = configPolicy.parse([
    ...rows,
    row('消息21101002: R793, 2, , 0', { at: NOW - 997, offset: 4, task: 'A1' }),
  ]);
  expect(configPolicy.resolveAccount(conflict.events, NOW).city).toBeUndefined();
});

test('多行事件id按原行序号映射，单行元数据冲突明确未知而非借AppleID', () => {
  const first = row('开始下单 iPhone Duo 星光白色 512G(x1)....', { account: '001' });
  const second = row('开始下单 iPhone Duo 星光白色 512G(x1)....', { account: '002' });
  const parsed = configPolicy.parse([{ ...first, message: first.message + second.message }]);
  expect(parsed.events.map(event => event.id)).toEqual([`${first.id}:0`, `${first.id}:1`]);
  expect(parsed.accounts.map(account => account.accountNumber)).toEqual(['001', '002']);
  const conflicting = configPolicy.parse([
    row('开始下单 iPhone Duo 星光白色 512G(x1)....', { account: '001', metadataAccount: '002' }),
  ]);
  expect(conflicting.events[0].body.invalid).toBe('ACCOUNT_METADATA_CONFLICT');
  expect(configPolicy.resolveAccount(conflicting.events, NOW).model).toBeUndefined();
  expect(JSON.stringify(parsed)).not.toMatch(/开始下单|\[2\]|AppleID|@/);
});

test('Collector允许空首括号，明确新startup必须被解析或记录gap，不可静默保留旧设置', () => {
  const input = row('开始下单 iPhone Duo 夜空色 1T(x1)....', { at: NOW - 500 });
  input.message = input.message.replace('[2]', '[]');
  const parsed = configPolicy.parse([input]);
  // FullLogScanner.Header的首括号是*，且parsed由合法前23位时间独立决定。
  const recognized = parsed.events.some(event => event.kind === 'start');
  expect(recognized || parsed.gaps.length > 0).toBe(true);
});

test('有时间无编号startup可由Collector标为parsed，须留gap；普通无关parsed行不滥记gap', () => {
  const input = row('开始下单 iPhone Duo 夜空色 1T(x1)....', { at: NOW - 500 });
  input.message = input.message.replace('[2][001]', '');
  input.accountNumber = null;
  const parsed = configPolicy.parse([input]);
  expect(parsed.gaps).toHaveLength(1);
  expect(parsed.gaps[0].at).toBe(input.loggedAt);
  const noise = {
    ...input,
    message: input.message.replace('开始下单 iPhone Duo 夜空色 1T(x1)....', '普通运行状态'),
  };
  expect(configPolicy.parse([noise]).gaps).toEqual([]);
});

/** formatter独立fixture：同一来源跨城，同城两门店不能重复累计比例分子。 */
function formattedGroups() {
  const groups = {};
  const source = { key: `${DEVICE}:${INSTANCE}`, server: 'US_12', instance: '心蓝13' };
  const item = {
    ...SCOPE,
    storeCode: 'R577',
    storeName: 'Apple 天环广场',
    observedAt: NOW,
    source,
  };
  signalPolicy.addGroup(groups, item);
  signalPolicy.addGroup(groups, { ...item, storeCode: 'R639', storeName: 'Apple 珠江新城' });
  signalPolicy.addGroup(groups, {
    ...item,
    city: '深圳',
    storeCode: 'R761',
    storeName: 'Apple 深圳万象城',
  });
  return { groups, source, item };
}

test('summary相同SKU跨城分别列N/D，同城多店来源只列一次且不把门店N相加', () => {
  const { groups, source } = formattedGroups();
  const ratios = { version: 1, scopes: {} };
  for (const [city, denominator] of [
    ['广州', 23],
    ['深圳', 26],
  ])
    ratios.scopes[accountRatios.scopeKey({ ...SCOPE, city })] = {
      sources: { [source.key]: { numerator: 1, denominator } },
    };
  const content = ratioContent.formatSummary(groups, ratios);
  const guangzhou = content.split('\n\n').find(block => block.includes('广州 ·'));
  const shenzhen = content.split('\n\n').find(block => block.includes('深圳 ·'));
  expect(guangzhou).toContain('广州 · Apple 天环广场｜1次\n广州 · Apple 珠江新城｜1次');
  expect(guangzhou.match(/US_12 \/ 心蓝13/g)).toHaveLength(1);
  expect(guangzhou).toContain('US_12 / 心蓝13｜1/23');
  expect(shenzhen).toContain('US_12 / 心蓝13｜1/26');
  expect(content).not.toMatch(/2\/49|https?:|[\r\n]$/);
});

test('未知比例固定显示—，不把raw日志次数充当N或输出百分比', () => {
  const { groups } = formattedGroups();
  const content = ratioContent.formatSummary(groups, { version: 1, scopes: {} });
  expect(content.match(/US_12 \/ 心蓝13｜—\/—/g)).toHaveLength(2);
  expect(content).not.toMatch(/%|％|\d+次\//);
});

test('首次消息即使提供ratio仍逐字保持旧格式和无尾CRLF', () => {
  const { groups } = formattedGroups();
  const module = { exports: {} };
  vm.runInNewContext(legacyApi.policySource, {
    module,
    require: createRequire(require.resolve('../src/services/aosSignalPolicy')),
    Buffer,
    structuredClone,
  });
  expect(signalPolicy.content(groups, true, { version: 1, scopes: {} })).toBe(
    module.exports.content(groups, true)
  );
});

test('长summary含标题仍<=1600字节，首个商品/门店和ratio可见，省略raw计数守恒', () => {
  const { source } = formattedGroups();
  const groups = {};
  for (let index = 0; index < 120; index += 1)
    signalPolicy.addGroup(groups, {
      ...SCOPE,
      color: `颜色${index}`,
      storeCode: `R${index}`,
      storeName: `Apple 门店${index}`,
      observedAt: NOW,
      source,
    });
  const content = ratioContent.formatSummary(groups, { version: 1, scopes: {} });
  expect(content).toContain('3分钟汇总｜120次命中｜120家门店');
  expect(content).toContain('iPhone Duo · 颜色0 · 512G\n广州 · Apple 门店0｜1次');
  expect(content).toContain('US_12 / 心蓝13｜—/—');
  expect(content).toMatch(/其余\d+组｜\d+次未展示/);
  const visible = [...content.matchAll(/｜(\d+)次$/gm)].reduce(
    (sum, match) => sum + Number(match[1]),
    0
  );
  const omitted = [...content.matchAll(/其余\d+组｜(\d+)次未展示/g)].reduce(
    (sum, match) => sum + Number(match[1]),
    0
  );
  expect(visible + omitted).toBe(120);
  expect(Buffer.byteLength(`【AOS 放货信号】\n${content}`, 'utf8')).toBeLessThanOrEqual(1600);
  expect(content).not.toMatch(/https?:|[\r\n]$/);
});
