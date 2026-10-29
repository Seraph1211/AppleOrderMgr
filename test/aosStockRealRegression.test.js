/* eslint-disable no-magic-numbers */
const fixture = require('./fixtures/aosStockTianjin20261029.json');
const signals = require('../src/services/aosSignalPolicy');
const stock = require('../src/services/aosStockTaskPolicy');
const ratio = require('../src/services/aosTaskRatioService');
const config = require('../src/services/aosTaskConfigPolicy');
const scope = { city: '天津', model: 'iPhone Duo', color: '星光白色', capacity: '512G' };
const from = Date.parse('2026-10-29T12:17:51.278Z');
const to = from + 180000;
const entries = () =>
  fixture.rows.flatMap(row =>
    signals
      .parseEntries(row, Math.max(+new Date(row.createdAt), from), { configurationOnly: true })
      .concat(signals.parseEntries(row, +new Date(row.createdAt)))
  );

function replay() {
  const all = [...new Map(entries().map(row => [row.id, row])).values()];
  const contexts = new Map();
  for (const taskKey of new Set(all.map(row => row.taskKey))) {
    const events = all.filter(row => row.taskKey === taskKey);
    const head = events[0];
    const history = all
      .filter(row => row.configurationBare && row.configurationKey === head.configurationKey)
      .map(row => ({ ...row, taskKey }));
    events.push(...history);
    const source = fixture.sources.find(row => row.deviceId === events[0].deviceId);
    contexts.set(
      taskKey,
      signals.mergeContext(
        null,
        events,
        {
          ...source,
          key: `${events[0].deviceId}:${events[0].localId}`,
          enabled: true,
        },
        to
      )
    );
  }
  const buffer = stock.collect(null, all, contexts, from + 90000, from - 180000);
  buffer.startedAt = from - 180000;
  const tracker = {
    refs: all
      .filter(row => row.kind === 'anchor')
      .map(anchor => ({
        anchor,
        item: signals.observation(contexts.get(anchor.taskKey), anchor),
      })),
  };
  tracker.stock = stock.snapshot(buffer, tracker, from, to, true);
  return { all, contexts, buffer, tracker };
}

test('天津真实脱敏40条省略号有货日志全部识别，历史启动补证后输出6/11/11和10/29/29', async () => {
  const { all, buffer, tracker } = replay();
  expect(all.filter(row => row.kind === 'stock')).toHaveLength(40);
  expect(buffer.refs.filter(ref => ref.reason)).toEqual([]);
  const models = {
    MonitorInstance: { findOne: ({ where }) => Promise.resolve({ id: where.deviceId }) },
    AosTaskConfigVersion: {
      findAll: ({ where }) =>
        Promise.resolve([
          {
            id: where.instanceId,
            effectiveAt: new Date(from - 86400000),
            effectiveTo: null,
            aggregates: [
              {
                ...scope,
                taskCount: fixture.sources.find(s => s.deviceId === where.instanceId).configured,
              },
            ],
          },
        ]),
    },
  };
  const result = await ratio.evaluate(tracker, models);
  const sources = result.scopes[config.scopeKey(scope)].sources;
  for (const source of fixture.sources) {
    const value = Object.values(sources).find(row => row.source.server === source.server);
    expect(value).toMatchObject({
      numerator: source.submitted,
      stockCount: source.configured,
      denominator: source.configured,
      reason: null,
      stockReason: null,
    });
  }
});

test('真实重复预约压缩前有超过12条原事件，压缩后有货证据不超限且重启保持', () => {
  const { contexts, buffer, tracker } = replay();
  expect([...contexts.values()].some(context => context.events.length > 12)).toBe(true);
  expect(buffer.refs.every(ref => ref.evidence.length <= 12)).toBe(true);
  const restored = stock.refreshSnapshot(
    JSON.parse(JSON.stringify(tracker.stock)),
    null,
    new Map()
  );
  expect(restored.refs).toHaveLength(40);
  expect(restored.refs.every(ref => ref.reason === null)).toBe(true);
});

test.each(['...', '', ':', '：', ' '])('真实编号边界允许%s且不匹配相邻消息编号', suffix => {
  const real = fixture.rows.find(row => row.message.endsWith('消息20110501...'));
  const parse = ending =>
    signals.parseEntries(
      { ...real, message: real.message.replace('消息20110501...', `消息20110501${ending}`) },
      +new Date(real.createdAt)
    );
  expect(parse(suffix).some(row => row.kind === 'stock')).toBe(true);
  for (const bad of ['0', '9', 'abc']) expect(parse(bad)).toEqual([]);
});

test('历史配置模式仅接受三天内设置，不补发旧stock或提交，不接受未来设置', () => {
  const start = fixture.rows.find(row => row.message.includes('开始下单 '));
  const at = +new Date(start.loggedAt);
  expect(signals.parseEntries(start, at + 3 * 86400000, { configurationOnly: true })).toHaveLength(
    1
  );
  expect(signals.parseEntries(start, at + 3 * 86400000 + 1, { configurationOnly: true })).toEqual(
    []
  );
  expect(signals.parseEntries(start, at - 1, { configurationOnly: true })).toEqual([]);
  const detected = fixture.rows.find(row => row.message.endsWith('-消息20110501...'));
  expect(
    signals.parseEntries(detected, +new Date(detected.createdAt), { configurationOnly: true })
  ).toEqual([]);
});
