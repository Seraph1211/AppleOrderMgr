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

/** 将明确的美国服务器编号统一为通知展示名；无法识别时保留原名称。 @param {string} value 档案名称 @returns {string} 通知展示名 */
function serverName(value) {
  const name = String(value || UNKNOWN);
  const number = name.match(/^US(?:[\s_]*Server)?(?:[\s_]*(?:No\.?|#))?[\s_]*(\d+)$/i)?.[1];
  return number ? `US_${number.padStart(2, '0')}` : name;
}

const CONTENT_BYTES = 1520;
const SOURCE_RESERVE_BYTES = 320;

/** 显示北京时间秒级范围；跨年保留年份，不改变源时间精度。 */
function timeRange(rows) {
  const timestamps = rows.flatMap(row => [row.firstAt, row.lastAt]).filter(Number.isFinite);
  if (!timestamps.length) return '';
  const clock = value => new Date(value + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const first = clock(Math.min(...timestamps));
  const last = clock(Math.max(...timestamps));
  const crossYear = first.slice(0, 4) !== last.slice(0, 4);
  const start = crossYear ? first : first.slice(5);
  if (first === last) return `时间：${start}`;
  let end = crossYear ? last : last.slice(5);
  if (first.slice(0, 10) === last.slice(0, 10)) end = last.slice(11);
  return `时间：${start}～${end}`;
}

/** 按店铺、机型稳定分组，让非连续输入仍只显示一次标题。 */
function detailRows(rows) {
  const stores = new Map();
  for (const row of rows) {
    const key = hasLocation(row)
      ? `store:${row.storeCode}`
      : JSON.stringify([row.city, row.storeCode, row.storeName]);
    if (!stores.has(key))
      stores.set(key, { city: row.city, name: row.storeName, models: new Map() });
    const store = stores.get(key);
    if (!store.models.has(row.model)) store.models.set(row.model, []);
    store.models
      .get(row.model)
      .push({ ...row, city: store.city, storeName: store.name, storeKey: key });
  }
  return [...stores.values()].flatMap(store => [...store.models.values()].flat());
}

/** 来源最后呈现，超长时保留省略来源数量及命中数。 */
function sourceContent(rows, budget) {
  if (!rows.length) return '';
  const line = row =>
    `${shorten(serverName(row.server), 12)} / ${shorten(row.instance, 10)}｜${row.count}次`;
  if (rows.length === 1) return `来源：${line(rows[0])}`;
  let text = '来源：';
  for (let index = 0; index < rows.length; index++) {
    const next = `${text}\n${line(rows[index])}`;
    const omitted = rows.slice(index + 1).reduce((sum, row) => sum + row.count, 0);
    const marker = omitted ? `\n其余${rows.length - index - 1}个来源｜${omitted}次未展示` : '';
    if (Buffer.byteLength(next + marker, 'utf8') > budget) {
      const remaining = rows.slice(index).reduce((sum, row) => sum + row.count, 0);
      return `${text}\n其余${rows.length - index}个来源｜${remaining}次未展示`;
    }
    text = next;
  }
  return text;
}

/** 在手机纯文本层次中展示完整总计；优先商品且明确保留省略数。 */
function content(groups, immediate) {
  const rows = detailRows(Object.values(groups));
  const sources = new Map();
  for (const row of rows)
    for (const [key, value] of Object.entries(row.sources)) {
      const previous = sources.get(key);
      sources.set(key, { ...value, count: (previous?.count || 0) + value.count });
    }
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const stores = new Set(rows.filter(hasLocation).map(row => row.storeCode));
  const unknown = rows.filter(row => !hasLocation(row)).reduce((sum, row) => sum + row.count, 0);
  const locations = unknown
    ? `${stores.size}家已知门店｜${unknown}次门店未知`
    : `${stores.size}家门店`;
  let text = `${immediate ? '首次信号' : '3分钟汇总'}｜${total}次命中｜${locations}`;
  const time = timeRange(rows);
  const sourceRows = [...sources.values()];
  const fullSources = sourceContent(sourceRows, CONTENT_BYTES);
  const sourceReserve = Math.min(Buffer.byteLength(fullSources, 'utf8'), SOURCE_RESERVE_BYTES);
  const footerBytes = Buffer.byteLength(time, 'utf8') + sourceReserve + 8;
  let shown = 0;
  let previous;
  for (const row of rows) {
    let heading = '';
    if (row.storeKey !== previous?.storeKey)
      heading = `\n\n${shorten(row.city, 12)} · ${shorten(row.storeName, 30)}\n${shorten(row.model, 24)}\n`;
    else if (row.model !== previous?.model) heading = `\n${shorten(row.model, 24)}\n`;
    else heading = '\n';
    const line = `${heading}${shorten(row.color, 20)} · ${shorten(row.capacity, 12)}｜${row.count}次`;
    const remaining = rows.slice(shown + 1).reduce((sum, item) => sum + item.count, 0);
    const marker = remaining ? `\n\n其余${rows.length - shown - 1}组｜${remaining}次未展示` : '';
    if (Buffer.byteLength(text + line + marker, 'utf8') + footerBytes > CONTENT_BYTES) break;
    text += line;
    previous = row;
    shown++;
  }
  if (shown < rows.length) {
    const omitted = rows.slice(shown).reduce((sum, row) => sum + row.count, 0);
    text += `\n\n其余${rows.length - shown}组｜${omitted}次未展示`;
  }
  if (time) text += `\n\n${time}`;
  const sourceBudget = CONTENT_BYTES - Buffer.byteLength(text, 'utf8') - 2;
  const sourceText = sourceContent(sourceRows, sourceBudget);
  if (sourceText) text += `\n\n${sourceText}`;
  return `${text}\n`;
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
  serverName,
};
