const { createHash } = require('crypto');
const stores = require('../config/proxyStores.json');
const { resolveProductName } = require('../utils/productNaming');

const WINDOW_MS = 180000;
const CONTEXT_MS = 86400000;
const MAX_CONTEXT_EVENTS = 100;
const MAX_ASSOCIATION_REFS = 1000;
const LOCATION_WAIT_MS = 10000;
const UNKNOWN = '未知';
const digest = value => createHash('sha256').update(value).digest('hex');
const order = (a, b) => a.byteOffset - b.byteOffset || (a.lineIndex || 0) - (b.lineIndex || 0);
const shorten = (value, size) => {
  const chars = [...String(value || UNKNOWN).replace(/[\r\n\t]/g, ' ')];
  return chars.length > size ? `${chars.slice(0, size).join('')}…` : chars.join('');
};

/** 仅提取通知需要的结构化字段，不持久化日志正文或账号。 */
function parseEntry(row, receivedAt) {
  const loggedAt = Date.parse(row.loggedAt);
  if (
    row.parseState !== 'parsed' ||
    row.partIndex !== 0 ||
    !Number.isFinite(loggedAt) ||
    loggedAt > receivedAt ||
    receivedAt - loggedAt > WINDOW_MS
  )
    return null;
  const match = row.message.match(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+(\[[^\]\r\n]+\]\[[^\]\r\n]+\][^\s\r\n]+?)-([^\r\n]*)/
  );
  if (!match) return null;
  const text = match[2];
  let kind;
  let details = {};
  if (/取货信息\s*[:：]\s*取货日期待付款完成后确定/.test(text)) kind = 'anchor';
  else if (text.includes('消息20110501')) kind = 'stock';
  else if (/^(?:开始登录|加入购物车成功)/.test(text)) kind = 'reset';
  else if (/尝试预约\s*[:：]/.test(text)) {
    kind = 'booking';
    const name = text.match(/尝试预约\s*[:：]\s*([^,，\r\n]+)/)?.[1].trim();
    const store = stores.find(item => item.name === name);
    if (store) details = { city: store.city, storeCode: store.code, storeName: store.name };
  } else if (/商品\s*[:：]/.test(text)) {
    kind = 'product';
    const name = text.replace(/^.*?商品\s*[:：]\s*/, '').split(/\s+x\s+\d+\s*[,，]/i)[0];
    const product = resolveProductName(name);
    if (product.matched)
      details = { model: product.modelName, color: product.color, capacity: product.capacity };
  } else return null;
  const { id, deviceId, localId, fileId, byteOffset } = row;
  const taskKey = digest(`${deviceId}:${localId}:${fileId}:${match[1]}`);
  return {
    id,
    deviceId,
    localId,
    fileId,
    byteOffset,
    loggedAt,
    receivedAt,
    taskKey,
    kind,
    ...details,
  };
}

/** 同一片段存在多个标准记录时逐行提取；无时间续行不猜任务和时间。 */
function parseEntries(row, receivedAt) {
  const lines = row.message.split(/\r?\n/);
  if (lines.filter(Boolean).length <= 1) return [parseEntry(row, receivedAt)].filter(Boolean);
  return lines.flatMap((message, lineIndex) => {
    const match = message.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (!match) return [];
    const item = parseEntry(
      { ...row, message, loggedAt: `${match[1]}T${match[2]}+08:00` },
      receivedAt
    );
    return item ? [{ ...item, id: `${row.id}:${lineIndex}`, lineIndex }] : [];
  });
}

/** 同源任务按原始偏移合并跨批上下文，保持固定内存上界。 */
function mergeContext(previous, entries, source, now) {
  const events = [...(previous?.events || []), ...entries.filter(row => row.kind !== 'anchor')];
  const unique = new Map(events.map(row => [row.id, row]));
  return {
    events: [...unique.values()].sort(order).slice(-MAX_CONTEXT_EVENTS),
    source,
    updatedAt: now,
  };
}

/** 严格限制在同任务最近有货或重启边界之后；不借用前一轮商品或门店。 */
function associationEvents(context, anchor) {
  const events = (context?.events || [])
    .filter(
      row =>
        ['deviceId', 'localId', 'fileId', 'taskKey'].every(key => row[key] === anchor[key]) &&
        order(row, anchor) < 0 &&
        row.loggedAt <= anchor.loggedAt
    )
    .sort(order);
  const lastBoundary = events.findLast(row => ['stock', 'reset'].includes(row.kind));
  const attempt = lastBoundary ? events.filter(row => order(row, lastBoundary) > 0) : events;
  return [
    lastBoundary,
    attempt.findLast(row => row.kind === 'booking'),
    attempt.findLast(row => row.kind === 'product'),
  ].filter(Boolean);
}

/** 仅在同任务最近边界之后提取已核实城市、门店与商品。 */
function observation(context, anchor) {
  const events = associationEvents(context, anchor);
  const attempt = events.some(row => ['stock', 'reset'].includes(row.kind)) ? events : [];
  const booking = attempt.findLast(row => row.kind === 'booking');
  const product = attempt.findLast(row => row.kind === 'product');
  return {
    city: booking?.city || UNKNOWN,
    storeCode: booking?.storeCode || UNKNOWN,
    storeName: booking?.storeName || UNKNOWN,
    model: product?.model || UNKNOWN,
    color: product?.color || UNKNOWN,
    capacity: product?.capacity || UNKNOWN,
    observedAt: anchor.loggedAt,
    source: context?.source || {
      key: `${anchor.deviceId}:${anchor.localId}`,
      server: UNKNOWN,
      instance: UNKNOWN,
    },
  };
}

/** 按五维规格合并并累计每台设备实例的日志命中数。 */
function addGroup(groups, item) {
  const key = digest(
    JSON.stringify([item.city, item.storeCode, item.model, item.color, item.capacity])
  );
  const group = groups[key] || { ...item, source: undefined, count: 0, sources: {} };
  group.count += 1;
  group.firstAt = Math.min(group.firstAt || item.observedAt, item.observedAt);
  group.lastAt = Math.max(group.lastAt || item.observedAt, item.observedAt);
  const source = group.sources[item.source.key] || { ...item.source, count: 0 };
  source.count += 1;
  group.sources[item.source.key] = source;
  groups[key] = group;
  return groups;
}

/** 城市与门店必须同时可核实；规格已知不能代替门店关联。 */
function hasLocation(item) {
  return ['city', 'storeCode', 'storeName'].every(key => item[key] && item[key] !== UNKNOWN);
}

/** 回退旧Worker只更新groups时冻结当前计数；无法归属的旧命中不猜锚点。 */
function ensureAssociation(window) {
  if (!window.association) return window;
  const association = window.association;
  const baseline = structuredClone(association.frozenGroups || {});
  for (const reference of association.refs) addGroup(baseline, reference.item);
  const counts = groups => {
    const sources = new Map();
    let total = 0;
    for (const group of Object.values(groups)) {
      total += group.count;
      for (const [key, source] of Object.entries(group.sources))
        sources.set(key, (sources.get(key) || 0) + source.count);
    }
    return JSON.stringify([total, [...sources.entries()].sort(([a], [b]) => a.localeCompare(b))]);
  };
  if (counts(window.groups) !== counts(baseline))
    window.association = {
      ...association,
      refs: [],
      frozenGroups: structuredClone(window.groups),
    };
  return window;
}

/** 保存有界脱敏锚点；超限部分冻结原分组，但仍保留全部来源与计数。 */
function addAssociation(window, anchor, item, context) {
  ensureAssociation(window);
  const association = window.association || {
    version: 1,
    refs: [],
    frozenGroups: structuredClone(window.groups || {}),
    overflowCount: 0,
  };
  if (association.refs.length < MAX_ASSOCIATION_REFS) {
    const reference = {};
    for (const key of [
      'id',
      'deviceId',
      'localId',
      'fileId',
      'taskKey',
      'byteOffset',
      'lineIndex',
      'loggedAt',
      'receivedAt',
    ])
      if (anchor[key] !== undefined) reference[key] = anchor[key];
    association.refs.push({ anchor: reference, item, events: referenceEvents(context, anchor) });
  } else {
    addGroup(association.frozenGroups, item);
    association.overflowCount += 1;
  }
  window.association = association;
  addGroup(window.groups, item);
  return window;
}

/** 每引用最多三条结构证据，避免任务上下文截尾后丢失已核实字段。 */
function referenceEvents(context, anchor) {
  return associationEvents(context, anchor).map(event => {
    const result = {};
    for (const key of [
      'id',
      'kind',
      'byteOffset',
      'lineIndex',
      'loggedAt',
      'city',
      'storeCode',
      'storeName',
      'model',
      'color',
      'capacity',
    ])
      if (event[key] !== undefined) result[key] = event[key];
    return result;
  });
}

/** 由锚点重新构造分组散列、来源计数和时间，避免只改标签留下旧分组。 */
function refreshAssociation(association, contexts) {
  const next = structuredClone(association);
  const groups = structuredClone(next.frozenGroups || {});
  for (const reference of next.refs) {
    const context = contexts.get(reference.anchor.taskKey);
    if (context) {
      const evidence = {
        ...context,
        events: [
          ...(reference.events || []).map(event => ({ ...reference.anchor, ...event })),
          ...(context.events || []),
        ],
      };
      reference.item = observation(evidence, reference.anchor);
      reference.events = referenceEvents(evidence, reference.anchor);
    }
    addGroup(groups, reference.item);
  }
  return { association: next, groups };
}

/** 在单条安全字节预算内优先保留全部来源，详情超长时明确省略。 */
function content(groups, immediate) {
  const rows = Object.values(groups);
  const sources = new Map();
  for (const row of rows)
    for (const [key, value] of Object.entries(row.sources)) {
      const previous = sources.get(key);
      sources.set(key, { ...value, count: (previous?.count || 0) + value.count });
    }
  const head = `${immediate ? '首次信号' : '3分钟汇总'}：${rows.reduce((n, row) => n + row.count, 0)}次命中（非库存数量）\n`;
  const timestamps = rows.flatMap(row => [row.firstAt, row.lastAt]).filter(Number.isFinite);
  const clock = value => new Date(value + 8 * 3600000).toISOString().slice(0, 23).replace('T', ' ');
  let times = '';
  if (timestamps.length) {
    const [startDate, startTime] = clock(Math.min(...timestamps)).split(' ');
    const [endDate, endTime] = clock(Math.max(...timestamps)).split(' ');
    const end = startDate === endDate ? endTime : `${endDate} ${endTime}`;
    times = `日志时间：${startDate} ${startTime} ～ ${end}\n`;
  }
  const sourceCodes = new Map([...sources.keys()].map((key, index) => [key, `S${index + 1}`]));
  const sourceText = `来源：${[...sources.values()].map(row => `${sourceCodes.get(row.key)} ${shorten(row.server, 12)}/${shorten(row.instance, 10)} ${row.count}次`).join('；')}\n`;
  let text = head + times;
  if (Buffer.byteLength(text + sourceText, 'utf8') <= 1100) text += sourceText;
  else {
    text += `来源共${sources.size}个实例；详情请在运行日志核对。\n`;
    for (const row of sources.values()) {
      const source = `${sourceCodes.get(row.key)} ${shorten(row.server, 6)}/${shorten(row.instance, 6)}；`;
      if (Buffer.byteLength(text + source, 'utf8') > 1050) break;
      text += source;
    }
    text += '\n';
  }
  let shown = 0;
  for (const row of rows) {
    const mapping = Object.entries(row.sources)
      .map(([key, source]) => `${sourceCodes.get(key)}×${source.count}`)
      .join('/');
    const line = `${row.city} · ${row.storeName} · ${row.model} ${row.color} ${row.capacity}：${row.count}次（${mapping}）\n`;
    if (Buffer.byteLength(text + line, 'utf8') > 1350) break;
    text += line;
    shown++;
  }
  if (shown < rows.length) text += `其余${rows.length - shown}组请在服务器监控的运行日志核对。\n`;
  return text;
}

module.exports = {
  WINDOW_MS,
  CONTEXT_MS,
  MAX_ASSOCIATION_REFS,
  LOCATION_WAIT_MS,
  parseEntry,
  parseEntries,
  mergeContext,
  observation,
  addGroup,
  hasLocation,
  ensureAssociation,
  addAssociation,
  refreshAssociation,
  content,
};
