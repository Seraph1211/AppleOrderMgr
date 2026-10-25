/* eslint-disable no-magic-numbers */
const { Op } = require('sequelize');
const policy = require('../src/services/aosSignalPolicy');
const AosSignalService = require('../src/services/aosSignalService');
const InventoryNotifier = require('../src/services/inventoryNotifier');

const NOW = Date.parse('2026-10-25T17:34:41.982+08:00');
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
          message: `2026-10-25 17:34:41.982 [2][013]A77-${text}`,
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
  return { context, store, feed, rows, deliveries, service: () => new AosSignalService(store) };
}

const ANCHOR = '取货信息: 取货日期待付款完成后确定';
const ATTEMPT = [
  '消息20110501',
  '尝试预约: Apple 前海壹方城, 日期',
  '商品: iPhone Duo 512GB 星光白色 x 1, RMB 1',
  ANCHOR,
];

/** 用户确认的三门店、多规格合成样例，计数严格为12。 */
function sampleGroups() {
  const groups = {};
  const source = { key: 'twelve', server: 'US12', instance: '心蓝13' };
  for (const spec of [
    { storeCode: 'R576', storeName: 'Apple 深圳万象城', color: '夜空色', capacity: '1T', count: 5 },
    {
      storeCode: 'R576',
      storeName: 'Apple 深圳万象城',
      color: '星光白色',
      capacity: '512G',
      count: 3,
    },
    { storeCode: 'R577', storeName: 'Apple 壹方城', color: '夜空色', capacity: '2T', count: 3 },
    {
      city: '广州',
      storeCode: 'R639',
      storeName: 'Apple 天环广场',
      color: '星光白色',
      capacity: '512G',
      count: 1,
      source: { key: 'twentyone', server: 'US_21', instance: '心蓝21' },
      observedAt: Date.parse('2026-10-25T17:35:36.181+08:00'),
    },
  ])
    for (let index = 0; index < spec.count; index += 1)
      policy.addGroup(groups, item({ source, ...spec }));
  return groups;
}

test('手机正文完整匹配用户三门店样例，摘要和详情、时间、来源按确认顺序排列', () => {
  expect(policy.content(sampleGroups(), false).trim()).toBe(
    [
      '3分钟汇总｜12次命中｜3家门店',
      '',
      '深圳 · Apple 深圳万象城',
      'iPhone Duo',
      '夜空色 · 1T｜5次',
      '星光白色 · 512G｜3次',
      '',
      '深圳 · Apple 壹方城',
      'iPhone Duo',
      '夜空色 · 2T｜3次',
      '',
      '广州 · Apple 天环广场',
      'iPhone Duo',
      '星光白色 · 512G｜1次',
      '',
      '时间：10-25 17:34:41～17:35:36',
      '',
      '来源：',
      'US_12 / 心蓝13｜11次',
      'US_21 / 心蓝21｜1次',
    ].join('\n')
  );
});

test('同店多机型、多规格及非连续输入归组，门店和机型不重复', () => {
  const groups = {};
  policy.addGroup(groups, item({ capacity: '1T' }));
  policy.addGroup(groups, item({ city: '广州', storeCode: 'R639', storeName: 'Apple 天环广场' }));
  policy.addGroup(groups, item({ model: 'iPhone 18 Pro', color: '星宇橙色' }));
  policy.addGroup(groups, item({ color: '夜空色' }));
  policy.addGroup(groups, item({ model: 'iPhone 18 Pro', color: '深蓝色', capacity: '1T' }));
  const text = policy.content(groups, false);
  expect(text.match(/深圳 · Apple 前海壹方城/g)).toHaveLength(1);
  expect(text.match(/广州 · Apple 天环广场/g)).toHaveLength(1);
  expect(text.match(/iPhone 18 Pro/g)).toHaveLength(1);
  const firstStore = text.slice(text.indexOf('深圳 ·'), text.indexOf('广州 ·'));
  expect(firstStore).toContain('iPhone Duo\n星光白色 · 1T｜1次\n夜空色 · 512G｜1次');
  expect(firstStore).toContain('iPhone 18 Pro\n星宇橙色 · 512G｜1次\n深蓝色 · 1T｜1次');
  expect(text).toContain('3分钟汇总｜5次命中｜2家门店');
});

test('同门店代码的不同显示别名只显示一次门店，唯一店数与店段数量一致', () => {
  const groups = {};
  policy.addGroup(groups, item({ capacity: '1T' }));
  policy.addGroup(groups, item({ storeName: 'Apple 壹方城', color: '夜空色' }));
  const text = policy.content(groups, false);
  expect(text).toContain('3分钟汇总｜2次命中｜1家门店');
  expect(text.match(/深圳 · Apple /g)).toHaveLength(1);
  expect(text).toContain('星光白色 · 1T｜1次');
  expect(text).toContain('夜空色 · 512G｜1次');
});

test('首次和单来源精简为同一行，纯文本没有项目符号或临时S编号', () => {
  const text = policy.content(policy.addGroup({}, item()), true);
  expect(text).toContain('首次信号｜1次命中｜1家门店');
  expect(text).toContain('来源：US_21 / 心蓝21｜1次');
  expect(text).not.toMatch(/S\d+|^- |\*\*|【来源】/m);
});

test.each([
  ['2026-10-25T17:34:41.001+08:00', '2026-10-25T17:34:41.999+08:00', '时间：10-25 17:34:41'],
  [
    '2026-10-25T17:34:41.982+08:00',
    '2026-10-25T17:35:36.181+08:00',
    '时间：10-25 17:34:41～17:35:36',
  ],
  [
    '2026-10-25T23:59:59.999+08:00',
    '2026-10-26T00:00:00.001+08:00',
    '时间：10-25 23:59:59～10-26 00:00:00',
  ],
  [
    '2026-12-31T23:59:59.999+08:00',
    '2027-01-01T00:00:00.001+08:00',
    '时间：2026-12-31 23:59:59～2027-01-01 00:00:00',
  ],
])('秒级时间简写与日/年边界可区分，同时原始毫秒保持：%s', (from, to, expected) => {
  const groups = {};
  policy.addGroup(groups, item({ observedAt: Date.parse(to) }));
  policy.addGroup(groups, item({ observedAt: Date.parse(from) }));
  const before = JSON.stringify(groups);
  const timeLine = policy
    .content(groups, false)
    .split('\n')
    .find(line => line.startsWith('时间：'));
  expect(timeLine).toBe(expected);
  expect(JSON.stringify(groups)).toBe(before);
  const group = Object.values(groups)[0];
  expect(group.firstAt).toBe(Date.parse(from));
  expect(group.lastAt).toBe(Date.parse(to));
});

test('未知门店不虚增门店数，未知规格可读且不污染其他门店计数', () => {
  const groups = {};
  policy.addGroup(groups, item());
  policy.addGroup(
    groups,
    item({
      city: '未知',
      storeCode: '未知',
      storeName: '未知',
      model: '未知',
      color: '未知',
      capacity: '未知',
    })
  );
  const text = policy.content(groups, false);
  expect(text).toContain('2次命中');
  expect(text).toContain('1家已知门店');
  expect(text).toContain('1次门店未知');
  expect(text).not.toContain('2家门店');
  expect(text).toContain('未知');
});

test('AOS最终包装不附详情链接；普通库存机器人合成通知仍保留原详情链接', async () => {
  const previous = process.env.INVENTORY_PUBLIC_URL;
  process.env.INVENTORY_PUBLIC_URL = 'https://signal.example.invalid';
  try {
    const h = harness();
    await h.service().queue(sampleGroups(), h.context, false, NOW, NOW + 180000);
    const aos = await new InventoryNotifier(h.store, jest.fn()).claim();
    expect(aos.content).toMatch(/^【AOS 放货信号】\n3分钟汇总｜12次命中｜3家门店/);
    expect(aos.content).not.toMatch(/https?:|详情|server-monitor\/logs/);
    expect(Buffer.byteLength(aos.content, 'utf8')).toBeLessThanOrEqual(1600);
    const ordinary = harness();
    ordinary.deliveries.set('test-notice', {
      id: 'test-notice',
      kind: 'test',
      status: 'pending',
      destinationId: 'synthetic',
      content: '合成库存消息',
      notBefore: NOW,
      expiresAt: NOW + 180000,
      attempts: 0,
    });
    const notice = await new InventoryNotifier(ordinary.store, jest.fn()).claim();
    expect(notice.content).toContain(
      '详情（需登录）：https://signal.example.invalid/inventory-monitor'
    );
  } catch (error) {
    throw new Error('消息包装兼容验收失败', { cause: error });
  } finally {
    if (previous === undefined) delete process.env.INVENTORY_PUBLIC_URL;
    else process.env.INVENTORY_PUBLIC_URL = previous;
  }
});

test('升级前无关联引用的pending AOS按新格式出站，accepted历史内容及毫秒字段不改', async () => {
  try {
    const h = harness();
    await h.service().queue(sampleGroups(), h.context, false, NOW, NOW + 180000);
    const pending = h.rows()[0];
    pending.content = '- 3分钟汇总：12次命中（3家门店）\n旧格式';
    h.deliveries.set(pending.id, pending);
    const historical = JSON.parse(
      JSON.stringify({
        ...pending,
        id: 'historical',
        status: 'accepted',
        content: '历史原始内容不可改',
      })
    );
    h.deliveries.set(historical.id, historical);
    const before = JSON.stringify(historical);
    const claim = await new InventoryNotifier(h.store, jest.fn()).claim();
    expect(claim.content).toContain('3分钟汇总｜12次命中｜3家门店');
    expect(claim.content).not.toContain('旧格式');
    expect(JSON.stringify(h.deliveries.get(historical.id))).toBe(before);
    expect(Object.values(h.deliveries.get(pending.id).aosGroups)[0].firstAt).toBe(NOW);
  } catch (error) {
    throw new Error('旧待发与已发送历史兼容验收失败', { cause: error });
  }
});

test('手机排版不改变首次计入汇总：同批两条首次1、首窗汇总2，后续窗不累计', async () => {
  try {
    const h = harness();
    h.feed([...ATTEMPT, ANCHOR]);
    await h.service().tick();
    expect(total(h.rows()[0].aosGroups)).toBe(1);
    expect(total(h.context.state.aosSignals.groups)).toBe(2);
    h.context.now += 180000;
    await h.service().tick();
    expect(total(h.rows().find(row => !row.aosImmediate).aosGroups)).toBe(2);
    expect(h.rows().find(row => !row.aosImmediate).content).toContain('3分钟汇总｜2次命中');
    h.context.now += 1;
    h.feed([ANCHOR]);
    await h.service().tick();
    h.context.now += 180000;
    await h.service().tick();
    expect(
      h
        .rows()
        .filter(row => !row.aosImmediate)
        .map(row => total(row.aosGroups))
    ).toEqual([2, 1]);
  } catch (error) {
    throw new Error('计数规则保全验收失败', { cause: error });
  }
});

test('长消息优先展示至少首个门店商品；来源和明细省略后仍分别守恒且最终<=1600字节', async () => {
  try {
    const h = harness();
    const groups = {};
    for (let index = 0; index < 150; index += 1)
      policy.addGroup(
        groups,
        item({
          city: `城市${index}`,
          storeCode: `R${index}`,
          storeName: `Apple 门店${index}`,
          source: { key: `source-${index}`, server: `US${index}`, instance: `实例${index}` },
        })
      );
    await h.service().queue(groups, h.context, false, NOW, NOW + 180000);
    const { content } = await new InventoryNotifier(h.store, jest.fn()).claim();
    expect(content).toContain('3分钟汇总｜150次命中｜150家门店');
    expect(content).toContain('城市0 · Apple 门店0\niPhone Duo\n星光白色 · 512G｜1次');
    expect(content.indexOf('城市0 ·')).toBeLessThan(content.indexOf('来源：'));
    expect(content).toMatch(/其余\d+组.*\d+次/);
    expect(content).toMatch(/其余\d+个来源.*\d+次/);
    const [details, sources] = content.split('来源：');
    const sumVisible = section =>
      [...section.matchAll(/｜(\d+)次$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
    const omittedDetail = Number(details.match(/其余\d+组[^\d]*(\d+)次/)[1]);
    const omittedSource = Number(sources.match(/其余\d+个来源[^\d]*(\d+)次/)[1]);
    expect(sumVisible(details) + omittedDetail).toBe(150);
    expect(sumVisible(sources) + omittedSource).toBe(150);
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(1600);
    expect(content).not.toContain('http');
  } catch (error) {
    throw new Error('长消息优先级与守恒验收失败', { cause: error });
  }
});
