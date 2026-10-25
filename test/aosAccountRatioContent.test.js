/* eslint-disable no-magic-numbers */
const { createHash } = require('crypto');
const { formatSummary } = require('../src/services/aosAccountRatioContent');

const NOW = Date.parse('2026-10-25T20:45:24.123+08:00');
const source = (key = 'device:local', patch = {}) => ({
  key,
  server: 'US Server 12',
  instance: '心蓝13',
  count: 10,
  ...patch,
});
const group = (patch = {}) => ({
  city: '广州',
  storeCode: 'R639',
  storeName: 'Apple 天环广场',
  model: 'iPhone Duo',
  color: '星光白色',
  capacity: '512G',
  count: 10,
  firstAt: NOW,
  lastAt: NOW,
  sources: { 'device:local': source() },
  ...patch,
});
const scopeKey = row =>
  createHash('sha256')
    .update(JSON.stringify([row.city, row.model, row.color, row.capacity]))
    .digest('hex');
function ratiosFor(rows, numerator = 10, denominator = 23) {
  const scopes = {};
  for (const row of rows) {
    const key = scopeKey(row);
    scopes[key] ||= {
      city: row.city,
      model: row.model,
      color: row.color,
      capacity: row.capacity,
      sources: {},
    };
    Object.assign(
      scopes[key].sources,
      Object.fromEntries(
        Object.keys(row.sources).map(key => [
          key,
          {
            numerator,
            denominator,
            reason: null,
            firstAt: NOW,
            lastAt: NOW,
          },
        ])
      )
    );
  }
  return { version: 1, scopes };
}

test('精确匹配广州10/23正文，保留秒级时间且无标题、链接或尾换行', () => {
  const row = group();
  expect(formatSummary({ one: row }, ratiosFor([row]))).toBe(
    [
      '3分钟汇总｜10次命中｜1家门店',
      '',
      'iPhone Duo · 星光白色 · 512G',
      '广州 · Apple 天环广场｜10次',
      'US_12 / 心蓝13｜10/23',
      '',
      '时间：10-25 20:45:24',
    ].join('\n')
  );
});

test('同城同规格跨门店合并来源一次，分子分母不得按门店相加', () => {
  const first = group({ count: 7, sources: { 'device:local': source(undefined, { count: 7 }) } });
  const second = group({
    storeCode: 'R668',
    storeName: 'Apple 珠江新城',
    count: 8,
    sources: { 'device:local': source(undefined, { count: 8 }) },
  });
  const text = formatSummary({ first, second }, ratiosFor([first, second]));
  expect(text).toContain('3分钟汇总｜15次命中｜2家门店');
  expect(text).toContain('广州 · Apple 天环广场｜7次\n广州 · Apple 珠江新城｜8次');
  expect(text.match(/US_12 \/ 心蓝13｜10\/23/g)).toHaveLength(1);
  expect(text).not.toMatch(/20\/46|15\/23/);
});

test('同规格不同城市独立成段，不借用其他城市分母', () => {
  const guangzhou = group();
  const shenzhen = group({ city: '深圳', storeCode: 'R577', storeName: 'Apple 壹方城' });
  const ratios = ratiosFor([guangzhou, shenzhen]);
  ratios.scopes[scopeKey(shenzhen)].sources['device:local'] = { numerator: 3, denominator: 46 };
  const text = formatSummary({ guangzhou, shenzhen }, ratios);
  expect(text.match(/iPhone Duo · 星光白色 · 512G/g)).toHaveLength(2);
  expect(text).toContain('广州 · Apple 天环广场｜10次\nUS_12 / 心蓝13｜10/23');
  expect(text).toContain('深圳 · Apple 壹方城｜10次\nUS_12 / 心蓝13｜3/46');
  expect(text).not.toContain('/69');
});

test.each([
  [10, null, '10/—'],
  [null, null, '—/—'],
  [0, 23, '0/23'],
  [0, 0, '0/0'],
  [null, 23, '—/23'],
])('未知比例与已知零独立呈现：%s/%s', (n, d, expected) => {
  const row = group();
  expect(formatSummary({ row }, ratiosFor([row], n, d))).toContain(`心蓝13｜${expected}`);
});

test('缺失或不支持的比例快照不猜分母，缺来源明确标注', () => {
  const row = group();
  expect(formatSummary({ row })).toContain('心蓝13｜—/—');
  expect(formatSummary({ row }, { ...ratiosFor([row]), version: 2 })).toContain('心蓝13｜—/—');
  expect(formatSummary({ row: group({ sources: {} }) })).toContain('未知来源｜—/—');
});

test('旧或异常快照的有限分子大于分母时，分母降级未知', () => {
  const row = group();
  expect(formatSummary({ row }, ratiosFor([row], 24, 23))).toContain('心蓝13｜24/—');
  expect(formatSummary({ row }, ratiosFor([row], 1, 0))).toContain('心蓝13｜1/—');
  expect(formatSummary({ row }, ratiosFor([row], 24, 23))).not.toContain('24/23');
});

test('同一门店多个规格只计一家；未知门店计数单独说明', () => {
  const first = group();
  const second = group({ capacity: '1T', count: 2 });
  const unknown = group({ storeCode: '未知', storeName: '未知', count: 3 });
  const text = formatSummary({ first, second, unknown });
  expect(text).toContain('15次命中｜1家已知门店｜3次门店未知');
  expect(text).toContain('广州 · 门店未知｜3次');
});

test.each([
  ['2026-10-25T20:45:24.001+08:00', '2026-10-25T20:45:24.999+08:00', '时间：10-25 20:45:24'],
  ['2026-10-25T20:45:24+08:00', '2026-10-25T20:46:25+08:00', '时间：10-25 20:45:24～20:46:25'],
  [
    '2026-10-25T23:59:59+08:00',
    '2026-10-26T00:00:01+08:00',
    '时间：10-25 23:59:59～10-26 00:00:01',
  ],
  [
    '2026-12-31T23:59:59+08:00',
    '2027-01-01T00:00:01+08:00',
    '时间：2026-12-31 23:59:59～2027-01-01 00:00:01',
  ],
])('时间尾部保持日年边界与原始毫秒快照：%s', (from, to, expected) => {
  const groups = { row: group({ firstAt: Date.parse(from), lastAt: Date.parse(to) }) };
  const before = JSON.stringify(groups);
  expect(formatSummary(groups).endsWith(expected)).toBe(true);
  expect(JSON.stringify(groups)).toBe(before);
});

test('长多城消息保持完整总计、首段和时间；展示与省略命中严格守恒', () => {
  const rows = Array.from({ length: 150 }, (_, index) =>
    group({
      city: `城市${index}`,
      storeCode: `R${index}`,
      storeName: `Apple 门店${index}`,
      count: index + 1,
    })
  );
  const groups = Object.fromEntries(rows.map((row, index) => [index, row]));
  const text = formatSummary(groups, ratiosFor(rows));
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1520);
  expect(text).toContain('11325次命中｜150家门店');
  expect(text).toContain(
    'iPhone Duo · 星光白色 · 512G\n城市0 · Apple 门店0｜1次\nUS_12 / 心蓝13｜10/23'
  );
  const shown = [...text.matchAll(/ · Apple 门店\d+｜(\d+)次/g)].reduce((sum, m) => sum + +m[1], 0);
  const omitted = [...text.matchAll(/其余\d+组｜(\d+)次未展示/g)].reduce(
    (sum, m) => sum + +m[1],
    0
  );
  expect(shown + omitted).toBe(11325);
  expect(text.endsWith('时间：10-25 20:45:24')).toBe(true);
  expect(text).not.toMatch(/[\r\n]$/);
});

test('同城大量门店和来源同时省略时，来源与门店命中分别守恒', () => {
  const rows = Array.from({ length: 100 }, (_, index) =>
    group({
      storeCode: `R${index}`,
      storeName: `Apple 门店${index}`,
      count: 1,
      sources: { [`d:${index}`]: source(`d:${index}`, { server: `US_${index}`, count: 1 }) },
    })
  );
  const text = formatSummary(Object.fromEntries(rows.map((row, i) => [i, row])), ratiosFor(rows));
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1520);
  expect(text).toContain('Apple 门店0｜1次');
  expect(text).toContain('US_00 / 心蓝13｜10/23');
  const stores = [...text.matchAll(/ · Apple 门店\d+｜(\d+)次/g)].reduce((n, m) => n + +m[1], 0);
  const omittedStores = [...text.matchAll(/其余\d+组｜(\d+)次未展示/g)].reduce(
    (n, m) => n + +m[1],
    0
  );
  expect(stores + omittedStores).toBe(100);
  const shownSources = [...text.matchAll(/US_\d+ \/ 心蓝13｜/g)].length;
  const marker = text.match(/其余(\d+)个来源｜(\d+)次未展示/);
  expect(marker).not.toBeNull();
  expect(shownSources + +marker[1]).toBe(100);
  expect(+marker[1]).toBe(+marker[2]);
});

test('超长名称清理CRLF和tab且受预算约束，不产生额外标题、URL或尾行', () => {
  const row = group({
    model: '超长\r\n机型\t'.repeat(100),
    color: '颜色'.repeat(100),
    storeName: 'Apple\r\n长门店\t'.repeat(100),
    sources: {
      one: source('one', {
        server: '长服务器\r\n\t'.repeat(100),
        instance: '长实例\r\n\t'.repeat(100),
      }),
    },
  });
  const text = formatSummary({ row });
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1520);
  expect(text).not.toMatch(/[\r\t]|https?:|【AOS/);
  expect(text).toContain('…');
  expect(text).not.toMatch(/[\r\n]$/);
});

test('空数据或缺时间不产生尾换行且不修改比例对象', () => {
  expect(formatSummary({})).toBe('3分钟汇总｜0次命中｜0家门店');
  const row = group({ firstAt: undefined, lastAt: undefined });
  const ratios = ratiosFor([row]);
  const before = JSON.stringify(ratios);
  expect(formatSummary({ row }, ratios)).not.toMatch(/时间：|[\r\n]$/);
  expect(JSON.stringify(ratios)).toBe(before);
});
