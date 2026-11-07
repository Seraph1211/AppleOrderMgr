const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TIME_ZONE = 'Asia/Shanghai';

const dateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const toTimestamp = value => (typeof value === 'string' ? Date.parse(value) : value);
/** 格式化北京时间日期。 */
export const formatDate = timestamp => dateFormatter.format(toTimestamp(timestamp));
/** 格式化北京时间时分秒。 */
export const formatTime = timestamp => timeFormatter.format(toTimestamp(timestamp));
/** 格式化可能未同步的完整北京时间。 */
export const formatTimestamp = value => (value ? `${formatDate(value)} ${formatTime(value)}` : '—');

const startOfDay = date => Date.parse(`${date}T00:00:00+08:00`);

export const RANGE_PRESETS = [
  ['24h', '最近 24 小时'],
  ['today', '今天'],
  ['7d', '近 7 天'],
  ['all', '全部历史'],
];

export const FILTERS = [
  { key: 'city', label: '城市', all: '全部城市' },
  { key: 'storeId', label: '门店', all: '全部门店' },
  { key: 'family', label: '机型', all: '全部机型' },
  { key: 'color', label: '颜色', all: '全部颜色' },
  { key: 'storage', label: '容量', all: '全部容量' },
  { key: 'terminalId', label: '来源终端', all: '全部终端' },
];

/** 以当前北京时间填充默认日期选择。 */
export function defaultRange(now = Date.now()) {
  const today = formatDate(now);
  return { preset: '24h', from: today, to: today };
}

/** 以同步机型代码保留机型独立维度，并显示易读名称。 */
export function formatFamily(family) {
  if (!family.startsWith('iphone_')) return family;
  const model = family
    .slice('iphone_'.length)
    .split('_')
    .map(word => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
  return `iPhone ${model}`;
}

/** 为容量显示添加单位间距，筛选仍使用原始值。 */
export const formatStorage = value => value?.replace(/^(\d+)\s*(GB|TB)$/i, '$1 $2') || '—';

/** 生成独立分类选择，保留历史门店的城市关联。 */
export function buildOptions(catalog) {
  const choices = (values, format = value => value) =>
    values.map(value => ({ value, label: format(value) }));
  const stores = new Map();
  for (const { id, city, name } of catalog?.stores ?? []) {
    const existing = stores.get(id);
    if (existing) {
      if (city && !existing.cities.includes(city)) existing.cities.push(city);
    } else {
      stores.set(id, {
        value: id,
        label: city ? `${city} · ${name}` : name,
        cities: city ? [city] : [],
      });
    }
  }
  return {
    city: choices(catalog?.cities ?? []),
    storeId: [...stores.values()],
    family: choices(catalog?.families ?? [], formatFamily),
    color: choices(catalog?.colors ?? []),
    storage: choices(catalog?.capacities ?? [], formatStorage),
    terminalId: (catalog?.terminals ?? []).map(({ id, name }) => ({ value: id, label: name })),
  };
}

/** 返回日期筛选的毫秒时间边界。 */
export function getRangeBounds(range, now) {
  switch (range.preset) {
    case 'today':
      return { from: startOfDay(formatDate(now)), to: now };
    case '7d':
      return { from: startOfDay(formatDate(now)) - 6 * DAY, to: now };
    case 'all':
      return {};
    case 'custom':
      return { from: startOfDay(range.from), to: startOfDay(range.to) + DAY - 1 };
    default:
      return { from: now - DAY, to: now };
  }
}

/** 将统计窗口限制在 PP 已有记录的时间边界内。 */
export function getTrendBounds(bounds, catalog) {
  if (!catalog?.firstDetectedAt || !catalog.lastDetectedAt) return null;
  const from = Math.max(bounds.from ?? -Infinity, Date.parse(catalog.firstDetectedAt));
  const to = Math.min(bounds.to ?? Infinity, Date.parse(catalog.lastDetectedAt));
  return from <= to ? { from, to } : null;
}

/** 构造受权接口的重复分类参数。 */
export function availabilityParams(snapshot, bounds, selections, extras = {}) {
  const params = new URLSearchParams({ snapshot, ...extras });
  for (const key of ['from', 'to']) {
    if (bounds[key] !== undefined) params.set(key, new Date(bounds[key]).toISOString());
  }
  for (const { key } of FILTERS) {
    for (const value of selections[key]) params.append(key, value);
  }
  return params.toString();
}

/** 在已同步历史范围内补齐空时间桶，使折线显示实际的零条匹配记录。 */
export function buildAvailabilityTrend(bounds, rows, interval) {
  if (!bounds) return { points: [], models: [] };
  const hourly = interval === 'hour';
  const step = hourly ? HOUR : DAY;
  const bucketStart = timestamp =>
    hourly ? Math.floor(timestamp / HOUR) * HOUR : startOfDay(formatDate(timestamp));
  const first = bucketStart(bounds.from);
  const last = bucketStart(bounds.to);
  const points = Array.from({ length: (last - first) / step + 1 }, (_, index) => ({
    time: first + index * step,
    counts: Object.create(null),
  }));
  const models = new Set();
  for (const { time, family, count } of rows) {
    const point = points[(Date.parse(time) - first) / step];
    if (!point) continue;
    point.counts[family] = count;
    models.add(family);
  }
  return { points, models: [...models].sort() };
}
