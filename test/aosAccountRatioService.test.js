const { randomUUID } = require('crypto');
const configs = require('../src/services/aosAccountConfigService');
const policy = require('../src/services/aosAccountConfigPolicy');
const ratios = require('../src/services/aosAccountRatioService');
const at = Date.parse('2026-10-25T20:45:24+08:00');
const source = { key: 'dev:local', server: 'US_12', instance: '13号实例' };
const item = {
  city: '广州',
  storeCode: 'R639',
  storeName: 'Apple 天环广场',
  model: 'iPhone Duo',
  color: '星光白色',
  capacity: '512G',
  source,
  observedAt: at,
};
const anchor = (accountNumber, time = at) => ({
  id: randomUUID(),
  deviceId: 'dev',
  localId: 'local',
  fileId: 'file',
  byteOffset: 10,
  loggedAt: time,
  accountNumber,
});
const event = (accountNumber, kind, time, body, offset) => ({
  id: randomUUID(),
  accountNumber,
  kind,
  loggedAt: new Date(time).toISOString(),
  fileId: 'file',
  byteOffset: offset,
  lineIndex: 0,
  body,
});
const fixture = () => ({
  ready: true,
  registries: ['001', '002'].map(accountNumber => ({
    accountNumber,
    firstSeenAt: new Date(at - 10000).toISOString(),
  })),
  events: ['001', '002'].flatMap(account => [
    event(
      account,
      'start',
      at - 10000,
      { product: { model: item.model, color: item.color, capacity: item.capacity } },
      1
    ),
    event(account, 'city', at - 9000, { cities: ['广州'], unknown: false }, 2),
  ]),
  gaps: [],
});
const sourceRatio = result => result.scopes[ratios.scopeKey(item)].sources[source.key];
afterEach(() => jest.restoreAllMocks());

test('独立分子跨门店重复账号去重，准确分母冻结，raw日志次数不参与比例', async () => {
  const data = fixture();
  jest.spyOn(configs, 'load').mockResolvedValue(data);
  let tracker = ratios.add(null, anchor('001'), item);
  tracker = ratios.add(tracker, anchor('001', at + 1000), { ...item, storeCode: 'R577' });
  const result = await ratios.evaluate(tracker, {}, {});
  expect(sourceRatio(result)).toMatchObject({ numerator: 1, denominator: 2, reason: null });
});

test('新编号只有普通日志也会使后续可能匹配配置未知，不复用旧缓存误报精确D', async () => {
  const data = fixture();
  data.registries.push({ accountNumber: '003', firstSeenAt: new Date(at + 500).toISOString() });
  jest.spyOn(configs, 'load').mockResolvedValue(data);
  let tracker = ratios.add(null, anchor('001'), item);
  tracker = ratios.add(tracker, anchor('001', at + 1000), item);
  expect(sourceRatio(await ratios.evaluate(tracker, {}, {}))).toMatchObject({
    numerator: 1,
    denominator: null,
    reason: 'CONFIG_INCOMPLETE_DURING_WINDOW',
  });
});

test('首hit之后新配置不能借来补首hit的未知维度，已有编号不强加分母', async () => {
  const data = fixture();
  data.events = data.events.filter(row => row.accountNumber !== '001');
  data.events.push(
    event(
      '001',
      'start',
      at + 1,
      { product: { model: item.model, color: item.color, capacity: item.capacity } },
      4
    )
  );
  data.events.push(event('001', 'city', at + 2, { cities: ['广州'] }, 5));
  jest.spyOn(configs, 'load').mockResolvedValue(data);
  const result = sourceRatio(await ratios.evaluate(ratios.add(null, anchor('001'), item), {}, {}));
  expect(result.numerator).toBe(1);
  expect(result.denominator).toBeNull();
});

test('同毫秒位于hit之后的设置不能污染过去，未声明账号不得变成0分子', async () => {
  const data = fixture();
  data.events.push(
    event(
      '002',
      'start',
      at,
      { product: { model: item.model, color: '夜空色', capacity: '1T' } },
      11
    )
  );
  jest.spyOn(configs, 'load').mockResolvedValue(data);
  expect(
    sourceRatio(await ratios.evaluate(ratios.add(null, anchor('001'), item), {}, {})).denominator
  ).toBe(2);
  expect(
    sourceRatio(await ratios.evaluate(ratios.add(null, anchor(null), item), {}, {})).numerator
  ).toBeNull();
});

test('超过任务关联refs上限时不把可能错分scope的账号个数当精确N', async () => {
  jest.spyOn(configs, 'load').mockResolvedValue(fixture());
  const tracker = ratios.add(null, anchor('001'), item);
  tracker.associationOverflow = true;
  expect(sourceRatio(await ratios.evaluate(tracker, {}, {}))).toMatchObject({
    numerator: null,
    denominator: null,
    reason: 'ASSOCIATION_REFERENCE_LIMIT',
  });
});

test('已知不匹配维度排除未知城市，停止行本身不修改最近启动设置', () => {
  const data = fixture();
  data.registries.push({ accountNumber: '038', firstSeenAt: new Date(at - 10000).toISOString() });
  data.events.push(
    event(
      '038',
      'start',
      at - 10000,
      { product: { model: item.model, color: '夜空色', capacity: '1T' } },
      1
    )
  );
  expect(policy.population(data.registries, data.events, item, at).members).toEqual(['001', '002']);
});

test('旧活跃窗口缺少历史账号tracker，新增已知hit也不能冒充完整分子', async () => {
  jest.spyOn(configs, 'load').mockResolvedValue(fixture());
  const tracker = ratios.add(
    { version: 1, refs: [], snapshots: {}, incomplete: 'LEGACY_WINDOW_WITHOUT_ACCOUNT_TRACKER' },
    anchor('001'),
    item
  );
  const restored = ratios.refresh(JSON.parse(JSON.stringify(tracker)), { refs: [] });
  expect(sourceRatio(await ratios.evaluate(restored, {}, {}))).toMatchObject({
    numerator: null,
    denominator: null,
    reason: 'LEGACY_WINDOW_WITHOUT_ACCOUNT_TRACKER',
  });
});
