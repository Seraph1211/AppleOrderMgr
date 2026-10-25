/* eslint-disable no-magic-numbers */
const { Op } = require('sequelize');
const policy = require('../src/services/aosSignalPolicy');
const AosSignalService = require('../src/services/aosSignalService');
const InventoryNotifier = require('../src/services/inventoryNotifier');

const NOW = Date.parse('2026-10-24T19:48:35.943+08:00');
const SOURCE = { key: 'device:instance', server: 'US Server 21', instance: '心蓝21' };
const total = groups => Object.values(groups).reduce((sum, group) => sum + group.count, 0);
const item = (patch = {}) => ({
  city: '深圳',
  storeCode: 'R577',
  storeName: 'Apple 前海壹方城',
  model: 'iPhone Duo',
  color: '星光白色',
  capacity: '512G',
  source: SOURCE,
  observedAt: NOW,
  ...patch,
});

/** 使用真实服务与策略，仓库模拟JSON持久化，不运行外部采集或网络发送。 */
function harness() {
  const inbox = [];
  const contexts = new Map();
  const deliveries = new Map();
  const context = {
    state: {},
    settings: {
      config: { aosSignalsEnabled: true },
      aosSignalsSince: NOW - 1,
      destinationId: 'synthetic',
      testedDestination: 'synthetic',
      webhookCipher: 'synthetic-encrypted-placeholder',
    },
    now: NOW,
    transaction: {},
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const store = {
    locked: work => Promise.resolve(work(context)),
    rows: (name, options = {}) => {
      if (name !== 'InventoryDelivery') return Promise.resolve([]);
      const rows = [...deliveries.values()].filter(row =>
        Object.entries(options.where || {}).every(([key, value]) =>
          key.startsWith('body.') ? row[key.slice(5)] === value : true
        )
      );
      return Promise.resolve(rows.map(clone));
    },
    put: (_name, rows) => {
      for (const row of rows) deliveries.set(row.id, clone(row));
      return Promise.resolve();
    },
    db: { query: () => Promise.resolve([]) },
    m: {
      AosSignalInbox: {
        findAll: options =>
          Promise.resolve(
            inbox.filter(row => {
              const keys = options.where?.['body.taskKey']?.[Op.in];
              return !keys || keys.includes(row.body.taskKey);
            })
          ),
        destroy: () => {
          inbox.length = 0;
          return Promise.resolve();
        },
      },
      AosSignalContext: {
        findAll: options =>
          Promise.resolve(
            options.where.updatedAt
              ? []
              : [...contexts.values()].filter(row => options.where.id[Op.in].includes(row.id))
          ),
        bulkCreate: rows => {
          for (const row of rows) contexts.set(row.id, clone(row));
          return Promise.resolve();
        },
      },
      AosDevice: {
        findAll: () => Promise.resolve([{ id: 'device', name: SOURCE.server, enabled: true }]),
      },
      MonitorInstance: {
        findAll: () =>
          Promise.resolve([{ deviceId: 'device', localId: 'instance', label: SOURCE.instance }]),
      },
      MonitorLogState: { findAll: () => Promise.resolve([]) },
    },
  };
  let sequence = 0;
  const feed = (texts, at = context.now, offsets = []) => {
    for (const [index, text] of texts.entries()) {
      sequence += 1;
      const parsed = policy.parseEntry(
        {
          id: `entry-${sequence}`,
          deviceId: 'device',
          localId: 'instance',
          fileId: 'file',
          byteOffset: offsets[index] ?? sequence,
          loggedAt: new Date(at).toISOString(),
          parseState: 'parsed',
          partIndex: 0,
          message: `2026-10-24 19:48:35.943 [2][013]A77-${text}`,
        },
        context.now
      );
      if (parsed) {
        const { id, ...body } = parsed;
        inbox.push({ id, body });
      }
    }
  };
  const rows = () => [...deliveries.values()];
  return { context, store, feed, rows, service: () => new AosSignalService(store) };
}

const ANCHOR = '取货信息: 取货日期待付款完成后确定';
const ATTEMPT = [
  '消息20110501',
  '尝试预约: Apple 前海壹方城, 日期',
  '商品: iPhone Duo 512GB 星光白色 x 1, RMB 1',
  ANCHOR,
];

test('独立格式验收：单来源正文逐行匹配用户示例且不含S编号', () => {
  const groups = policy.addGroup({}, item());
  expect(policy.content(groups, true)).toBe(
    '首次信号｜1次命中｜1家门店\n\n' +
      '深圳 · Apple 前海壹方城\niPhone Duo\n星光白色 · 512G｜1次\n\n' +
      '时间：10-24 19:48:35\n\n' +
      '来源：US_21 / 心蓝21｜1次'
  );
});

test('独立格式验收：多来源按实际明细合计12次、3门店，不沿用示例错误9次', () => {
  const groups = {};
  const first = { key: 'twelve', server: 'US12', instance: '心蓝13' };
  const second = { key: 'twentyone', server: 'US Server No.21', instance: '心蓝21' };
  for (let index = 0; index < 8; index += 1)
    policy.addGroup(
      groups,
      item({
        storeCode: 'R576',
        storeName: 'Apple 深圳万象城',
        color: '夜空色',
        capacity: '1T',
        source: first,
      })
    );
  for (let index = 0; index < 3; index += 1)
    policy.addGroup(
      groups,
      item({ storeName: 'Apple 壹方城', color: '夜空色', capacity: '2T', source: first })
    );
  policy.addGroup(
    groups,
    item({ city: '广州', storeCode: 'R639', storeName: 'Apple 天环广场', source: second })
  );
  const text = policy.content(groups, false);
  expect(text).toContain('3分钟汇总｜12次命中｜3家门店\n');
  expect(text).toContain('来源：\nUS_12 / 心蓝13｜11次\nUS_21 / 心蓝21｜1次');
  expect(text).toContain('深圳 · Apple 深圳万象城\niPhone Duo\n夜空色 · 1T｜8次\n');
  expect(text).toContain('深圳 · Apple 壹方城\niPhone Duo\n夜空色 · 2T｜3次\n');
  expect(text).toContain('广州 · Apple 天环广场\niPhone Duo\n星光白色 · 512G｜1次');
  expect(text).not.toMatch(/S\d+|非库存数量/);
});

test('独立门店计数：同店多规格只计一家，未知门店不虚增已知店数', () => {
  const groups = {};
  policy.addGroup(groups, item());
  policy.addGroup(groups, item({ capacity: '1T' }));
  policy.addGroup(groups, item({ city: '未知', storeCode: '未知', storeName: '未知' }));
  const text = policy.content(groups, false);
  expect(text).toContain('3次命中｜1家已知门店｜1次门店未知');
});

test.each(['US Server 21', 'US Server No.21', 'US21', 'US_21'])(
  '独立来源格式：%s规范为US_21，不修改真实实例名',
  server => {
    expect(
      policy.content(policy.addGroup({}, item({ source: { ...SOURCE, server } })), true)
    ).toContain('来源：US_21 / 心蓝21｜1次');
  }
);

test('独立超长概览：保留实际总数、门店数与省略说明，受通知安全字节预算约束', () => {
  const groups = {};
  for (let index = 0; index < 150; index += 1)
    policy.addGroup(
      groups,
      item({
        city: `城市${index}`,
        storeCode: `R${index}`,
        storeName: `门店${index}${'长'.repeat(20)}`,
        source: { key: `source-${index}`, server: `US${index}`, instance: `实例${index}` },
      })
    );
  const text = policy.content(groups, false);
  expect(text).toContain('150次命中｜150家门店');
  expect(text).toMatch(/其余|省略/);
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1520);
  const [details, sources] = text.split('来源：\n');
  const visible = section =>
    [...section.matchAll(/｜(\d+)次$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
  const omittedSources = Number(sources.match(/其余\d+个来源｜(\d+)次/)[1]);
  const omittedGroups = Number(details.match(/其余\d+组｜(\d+)次/)[1]);
  expect(visible(sources) + omittedSources).toBe(150);
  expect(visible(details) + omittedGroups).toBe(150);
});

test('独立窗口验收：只有首次一条也在3分钟汇总，持久化后重建服务仍不重发首次', async () => {
  try {
    const h = harness();
    h.feed(ATTEMPT);
    await h.service().tick();
    expect(h.rows()).toHaveLength(1);
    expect(total(h.rows()[0].aosGroups)).toBe(1);
    expect(total(h.context.state.aosSignals.groups)).toBe(1);
    h.context.state = JSON.parse(JSON.stringify(h.context.state));
    h.context.now += 180000;
    await h.service().tick();
    expect(h.rows()).toHaveLength(2);
    expect(h.rows().filter(row => row.aosImmediate)).toHaveLength(1);
    expect(total(h.rows().find(row => !row.aosImmediate).aosGroups)).toBe(1);
    await h.service().tick();
    expect(h.rows()).toHaveLength(2);
  } catch (error) {
    throw new Error('单条和持久化恢复验收失败', { cause: error });
  }
});

test('独立克隆验收：同批两条锚点首次保持1，汇总2，来源与明细计数一致', async () => {
  try {
    const h = harness();
    h.feed([...ATTEMPT, ANCHOR]);
    await h.service().tick();
    expect(total(h.rows()[0].aosGroups)).toBe(1);
    expect(h.rows()[0].aosAssociation.refs).toHaveLength(1);
    expect(total(h.context.state.aosSignals.groups)).toBe(2);
    expect(h.context.state.aosSignals.association.refs).toHaveLength(2);
    h.context.now += 180000;
    await h.service().tick();
    const summary = h.rows().find(row => !row.aosImmediate);
    expect(total(summary.aosGroups)).toBe(2);
    expect(Object.values(summary.aosGroups)[0].sources[SOURCE.key].count).toBe(2);
    expect(summary.content).toContain('2次命中｜1家门店');
    expect(total(h.rows()[0].aosGroups)).toBe(1);
  } catch (error) {
    throw new Error('首次与汇总引用独立验收失败', { cause: error });
  }
});

test('独立精确边界验收：边界新命中进入下一窗，后续非累计，空窗后恢复首次', async () => {
  try {
    const h = harness();
    h.feed(ATTEMPT);
    await h.service().tick();
    h.context.now += 180000;
    h.feed([ANCHOR]);
    await h.service().tick();
    expect(h.rows().filter(row => !row.aosImmediate)).toHaveLength(1);
    expect(total(h.rows().find(row => !row.aosImmediate).aosGroups)).toBe(1);
    expect(total(h.context.state.aosSignals.groups)).toBe(1);
    h.context.now += 180000;
    await h.service().tick();
    expect(
      h
        .rows()
        .filter(row => !row.aosImmediate)
        .map(row => total(row.aosGroups))
    ).toEqual([1, 1]);
    h.context.now += 180000;
    await h.service().tick();
    expect(h.context.state.aosSignals).toBeNull();
    h.context.now += 1;
    h.feed([ANCHOR]);
    await h.service().tick();
    expect(h.rows().filter(row => row.aosImmediate)).toHaveLength(2);
    expect(total(h.context.state.aosSignals.groups)).toBe(1);
  } catch (error) {
    throw new Error('边界与空窗验收失败', { cause: error });
  }
});

test('独立旧窗口兼容：无association的旧groups保守保留计数，不虚构已遗失首次', async () => {
  try {
    const h = harness();
    h.context.state.aosSignals = {
      from: NOW - 180000,
      until: NOW,
      groups: policy.addGroup({}, item()),
    };
    await h.service().tick();
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0].aosImmediate).toBe(false);
    expect(total(h.rows()[0].aosGroups)).toBe(1);
  } catch (error) {
    throw new Error('旧持久窗口兼容验收失败', { cause: error });
  }
});

test('独立晚到关联：首条和汇总引用同时补齐门店，计数各保持1且门店统计更新', async () => {
  try {
    const h = harness();
    h.feed([ANCHOR], NOW, [4]);
    await h.service().tick();
    expect(h.rows()[0].content).toContain('0家已知门店｜1次门店未知');
    h.context.now += 1000;
    h.feed(ATTEMPT.slice(0, 3), NOW - 10, [1, 2, 3]);
    await h.service().tick();
    expect(h.rows()[0].content).toContain('1次命中｜1家门店');
    expect(h.rows()[0].content).toContain('Apple 前海壹方城');
    expect(total(h.rows()[0].aosGroups)).toBe(1);
    expect(total(h.context.state.aosSignals.groups)).toBe(1);
    expect(Object.values(h.context.state.aosSignals.groups)[0].storeName).toBe('Apple 前海壹方城');
    h.context.now = NOW + 180000;
    await h.service().tick();
    const summary = h.rows().find(row => !row.aosImmediate);
    expect(summary.content).toContain('1次命中｜1家门店');
    expect(total(summary.aosGroups)).toBe(1);
  } catch (error) {
    throw new Error('晚到上下文守恒验收失败', { cause: error });
  }
});

test('独立完整消息验收：notifier保留标题并移除AOS登录链接，最大概览包装后仍满足安全预算', async () => {
  const previous = process.env.INVENTORY_PUBLIC_URL;
  process.env.INVENTORY_PUBLIC_URL = 'https://signal.example.invalid';
  try {
    const h = harness();
    const groups = {};
    for (let index = 0; index < 150; index += 1)
      policy.addGroup(
        groups,
        item({
          storeCode: `R${index}`,
          storeName: `门店${index}`,
          source: { key: `source-${index}`, server: `US${index}`, instance: `实例${index}` },
        })
      );
    await h.service().queue(groups, h.context, false, NOW, NOW + 180000);
    const notifier = new InventoryNotifier(h.store, jest.fn());
    const message = await notifier.claim();
    expect(message.content).toMatch(/^【AOS 放货信号】\n3分钟汇总｜150次命中｜150家门店/);
    expect(message.content).not.toContain(
      '详情（需登录）：https://signal.example.invalid/server-monitor/logs'
    );
    expect(Buffer.byteLength(message.content, 'utf8')).toBeLessThanOrEqual(1600);
    expect(h.rows()[0].status).toBe('sending');
  } catch (error) {
    throw new Error('完整消息包装验收失败', { cause: error });
  } finally {
    if (previous === undefined) delete process.env.INVENTORY_PUBLIC_URL;
    else process.env.INVENTORY_PUBLIC_URL = previous;
  }
});
