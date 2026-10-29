const configPolicy = require('./aosAccountConfigPolicy');
const taskPolicy = require('./aosTaskConfigPolicy');

const WINDOW_MS = 180000;
const RETENTION_MS = WINDOW_MS * 2;
const MAX_REFS = 10000;
const MAX_EVIDENCE = 12;
const MAX_CONFIGURATION = 128;
const MAX_CONTEXT_EVENTS = 100;
const DIMENSIONS = ['city', 'model', 'color', 'capacity'];
const BOUNDARIES = ['stock', 'reset', 'configStart'];
const known = value => typeof value === 'string' && value && value !== '未知';
const order = (a, b) => configPolicy.compare(a, b);
const sameTask = (a, b) =>
  ['deviceId', 'localId', 'fileId', 'taskKey'].every(key => a[key] === b[key]);
const EVIDENCE_FIELDS = [
  'id',
  'deviceId',
  'localId',
  'fileId',
  'taskKey',
  'accountNumber',
  'configurationKey',
  'configurationBare',
  'byteOffset',
  'lineIndex',
  'loggedAt',
  'receivedAt',
  'kind',
  'city',
  'storeCode',
  'storeName',
  'model',
  'color',
  'capacity',
  'cities',
  'unknown',
  'response',
];
const clean = row =>
  Object.fromEntries(
    EVIDENCE_FIELDS.filter(key => row[key] !== undefined).map(key => [key, row[key]])
  );

function semanticKey(row) {
  if (row.kind === 'booking') return JSON.stringify([row.kind, row.city || '未知']);
  if (row.kind === 'product')
    return JSON.stringify([row.kind, ...DIMENSIONS.slice(1).map(key => row[key])]);
  if (row.kind === 'configCity')
    return JSON.stringify([
      row.kind,
      [...new Set(row.cities || [])].sort(),
      Boolean(row.unknown),
      Boolean(row.response),
    ]);
  return null;
}

function uniqueEvents(input) {
  return [...new Map(input.map(row => [row.id, row])).values()].sort(order);
}

// 保留首次语义证据的位置，晚到边界仍可将后轮证据排除；真实差异保留。
function compact(input) {
  const seen = new Set();
  return uniqueEvents(input).filter(row => {
    if (BOUNDARIES.includes(row.kind)) seen.clear();
    const key = semanticKey(row);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 保留有界启动历史及每轮城市证据，按事件时点选配置而非仅保留最新设置。 @param {Object} previous 旧上下文 @param {Object[]} entries 同任务结构事件 @returns {Object[]} 设置证据 */
function configuration(previous, entries) {
  const events = compact(
    [...(previous?.configuration || []), ...entries].filter(row =>
      ['configStart', 'configCity'].includes(row.kind)
    )
  );
  const bounded = events.slice(-MAX_CONFIGURATION);
  const firstStart = bounded.findIndex(row => row.kind === 'configStart');
  return firstStart < 0 ? [] : bounded.slice(firstStart).map(clean);
}

/** 为检测独立压缩尝试上下文，避免重复预约挤出商品，提交上下文保持原行为。 @param {Object} previous 旧上下文 @param {Object[]} entries 新事件 @returns {Object[]} 语义事件 */
function contextEvents(previous, entries) {
  return compact(
    [...(previous?.stockEvents || previous?.events || []), ...entries].filter(
      row => row.kind !== 'anchor'
    )
  )
    .slice(-MAX_CONTEXT_EVENTS)
    .map(clean);
}

function observe(ref, context) {
  const stock = ref.anchor;
  const unique = new Map(
    [
      ...(ref.evidence || []),
      ...(context?.configuration || []),
      ...(context?.stockEvents || context?.events || []),
    ]
      .filter(row => sameTask(row, stock))
      .map(row => [row.id, row])
  );
  const events = [...unique.values()].sort(order);
  const end = events.find(row => BOUNDARIES.includes(row.kind) && order(row, stock) > 0);
  const attempt = events.filter(
    row =>
      order(row, stock) > 0 &&
      (!end || order(row, end) < 0) &&
      row.loggedAt <= stock.loggedAt + WINDOW_MS &&
      (['booking', 'product'].includes(row.kind) || (row.kind === 'configCity' && row.response))
  );
  const start = events.findLast(row => row.kind === 'configStart' && order(row, stock) < 0);
  let cityConfig = [];
  if (start)
    cityConfig = events.filter(
      row => row.kind === 'configCity' && order(row, start) > 0 && order(row, stock) < 0
    );
  const bookings = attempt.filter(row => row.kind === 'booking');
  const products = attempt.filter(row => row.kind === 'product');
  const responses = attempt.filter(row => row.kind === 'configCity' && row.response);
  const cities = [
    ...new Set([...bookings.map(row => row.city), ...responses.flatMap(row => row.cities || [])]),
  ];
  const configuredCities = [...new Set(cityConfig.flatMap(row => row.cities || []))];
  const specs = new Map(products.map(row => [taskPolicy.scopeKey({ ...row, city: '' }), row]));
  const city =
    bookings.length || responses.length
      ? cities.length === 1 && !responses.some(row => row.unknown)
        ? cities[0]
        : null
      : configuredCities.length === 1 && !cityConfig.some(row => row.unknown)
        ? configuredCities[0]
        : null;
  const product = products.length ? (specs.size === 1 ? products[0] : null) : start;
  const item = {
    city: city || '未知',
    model: product?.model || '未知',
    color: product?.color || '未知',
    capacity: product?.capacity || '未知',
    source: context?.source || ref.item?.source,
  };
  // 只保存启动、城市及本尝试内证据；包含下个边界以防晚到内容跨尝试补齐。
  const evidence = compact([
    ...(start ? [start] : []),
    ...(!bookings.length && !responses.length ? cityConfig : []),
    stock,
    ...attempt,
    ...(end ? [end] : []),
  ]);
  const overflow = ref.evidenceOverflow || evidence.length > MAX_EVIDENCE;
  return {
    anchor: stock,
    item,
    evidenceOverflow: overflow,
    evidence: evidence.slice(0, MAX_EVIDENCE).map(clean),
    reason: overflow
      ? 'STOCK_EVIDENCE_LIMIT'
      : DIMENSIONS.every(key => known(item[key]))
        ? null
        : 'STOCK_SCOPE_UNKNOWN',
  };
}

/** 独立收集所有有货任务，跨tick／重启保留，失败任务无需提交锚点。 @param {Object} previous 旧运行态 @param {Object[]} entries 新事件 @param {Map} contexts 同任务上下文 @param {number} now 当前毫秒 @param {number} since 启用水位 @returns {Object} 新运行态 */
function collect(previous, entries, contexts, now, since) {
  const old = previous?.version === 1 && previous.since === since ? previous : null;
  const refs = new Map(
    (old?.refs || [])
      .filter(ref => ref.anchor.receivedAt >= now - RETENTION_MS)
      .map(ref => [ref.anchor.id, ref])
  );
  let overflowAt = old?.overflowAt >= now - RETENTION_MS ? old.overflowAt : null;
  let overflowFrom = overflowAt != null ? old.overflowFrom : null;
  for (const row of entries) {
    if (
      row.kind !== 'stock' ||
      row.loggedAt < since ||
      row.receivedAt < since ||
      row.loggedAt > row.receivedAt ||
      now - row.receivedAt > WINDOW_MS ||
      row.receivedAt - row.loggedAt > WINDOW_MS ||
      !contexts.get(row.taskKey)?.source?.enabled
    )
      continue;
    if (!refs.has(row.id) && refs.size >= MAX_REFS) {
      overflowAt = Math.max(overflowAt || 0, row.receivedAt);
      overflowFrom = Math.min(overflowFrom ?? row.receivedAt, row.receivedAt);
      continue;
    }
    if (!refs.has(row.id)) refs.set(row.id, { anchor: clean(row) });
  }
  return {
    version: 1,
    since,
    startedAt: old?.startedAt ?? now,
    closedUntil: old?.closedUntil || 0,
    overflowAt,
    overflowFrom,
    refs: [...refs.values()].map(ref => {
      const context = contexts.get(ref.anchor.taskKey);
      return context || !ref.item ? observe(ref, context) : ref;
    }),
  };
}

/** 冻结原接收窗口的有货观察；首窗包含本窗提交关联的前置检测，不跨前窗累计。 @param {Object} buffer 运行态 @param {Object} tracker 提交跟踪 @param {number} from 接收起点 @param {number} to 接收终点 @param {boolean} initial 是否首窗 @returns {Object} 有界统计证据 */
function snapshot(buffer, tracker, from, to, initial = false) {
  if (!buffer || !Number.isFinite(from) || !Number.isFinite(to))
    return { version: 1, reason: 'STOCK_TRACKER_MISSING', refs: [], from, to };
  let lower = from;
  if (initial) {
    const floor = Math.max(from - WINDOW_MS, buffer.closedUntil || 0);
    // 首次提交前，同范围已经有检测但尚未提交的任务同样属于首轮。
    // 最多回看现有新鲜度180秒，且绝不越过已结算窗口。
    for (const row of buffer.refs) {
      if (row.anchor.receivedAt < floor || row.anchor.receivedAt > from) continue;
      const matches = (tracker?.refs || []).some(
        ref =>
          !DIMENSIONS.some(
            key => known(row.item[key]) && known(ref.item[key]) && row.item[key] !== ref.item[key]
          )
      );
      if (matches) lower = Math.min(lower, row.anchor.receivedAt);
    }
  }
  return {
    version: 1,
    from: lower,
    to,
    reason:
      buffer.reason ||
      (buffer.startedAt > lower
        ? 'STOCK_TRACKING_STARTED_DURING_WINDOW'
        : buffer.overflowAt != null &&
            buffer.overflowAt >= lower &&
            (buffer.overflowFrom ?? buffer.overflowAt) < to
          ? 'STOCK_REFERENCE_LIMIT'
          : null),
    refs: buffer.refs
      .filter(row => row.anchor.receivedAt >= lower && row.anchor.receivedAt < to)
      .map(row => structuredClone(row)),
  };
}

/** 复核待发窗口时合并冻结证据与实时观察；缓存TTL不得删除已经计入窗口的任务。 @param {Object} previous 已冻结快照 @param {Object} buffer 运行态缓存 @param {Map} contexts 最新同任务上下文 @returns {Object} 新快照 */
function refreshSnapshot(previous, buffer, contexts) {
  if (!previous) return previous;
  const current = snapshot(buffer, null, previous.from, previous.to);
  const refs = new Map((previous.refs || []).map(ref => [ref.anchor.id, ref]));
  for (const ref of current.refs) refs.set(ref.anchor.id, ref);
  let reason = previous.reason;
  // 队列已追平时可解除临时积压；预热、缺口与历史超限不能被TTL清除。
  if (reason === 'STOCK_PENDING_QUEUE_LIMIT') reason = null;
  reason ||= buffer ? current.reason : null;
  if (refs.size > MAX_REFS) reason ||= 'STOCK_REFERENCE_LIMIT';
  return {
    ...previous,
    reason,
    refs: [...refs.values()].slice(0, MAX_REFS).map(ref => {
      const context = contexts.get(ref.anchor.taskKey);
      return context ? observe(ref, context) : structuredClone(ref);
    }),
  };
}

/** 取得可能属于该范围的有货观察，未知维度不能用于排除。 @param {Object} stock 有货快照 @param {Object} group 范围 @returns {Object[]} 候选 */
function candidates(stock, group) {
  const anchor = group.anchor || group.refs[0].anchor;
  return (stock?.refs || []).filter(
    ref =>
      ref.anchor.deviceId === anchor.deviceId &&
      ref.anchor.localId === anchor.localId &&
      !DIMENSIONS.some(key => known(ref.item[key]) && ref.item[key] !== group.scope[key])
  );
}

/** 配置版本必须覆盖检测和提交两个阶段，不能使用稍后配置补检测。 @param {Object} stock 快照 @param {Object} group 范围 @returns {number[]} 首末事件毫秒 */
function range(stock, group) {
  const times = [
    ...group.refs.map(ref => ref.anchor.loggedAt),
    ...candidates(stock, group).map(ref => ref.anchor.loggedAt),
  ];
  return [Math.min(...times), Math.max(...times)];
}

/** 计算同来源同城市规格去重有货任务；未知不能当零，提交不能补检测。 @param {Object} stock 窗口快照 @param {Object} group 提交范围 @param {Set} submitted 提交编号 @param {number} denominator 配置数 @param {Object} version 有效配置版本 @returns {Object} 有货数、证据及原因 */
function count(stock, group, submitted, denominator, version) {
  let reason = stock?.reason || (!stock ? 'STOCK_TRACKER_MISSING' : null);
  const accounts = new Set();
  const diagnostics = { observed: 0, attributed: 0, reasons: {} };
  const files = new Set(group.refs.map(ref => ref.anchor.fileId));
  for (const ref of candidates(stock, group)) {
    reason ||= ref.reason;
    diagnostics.observed += 1;
    if (ref.reason) diagnostics.reasons[ref.reason] = (diagnostics.reasons[ref.reason] || 0) + 1;
    else diagnostics.attributed += 1;
    if (
      version &&
      (ref.anchor.loggedAt < +new Date(version.effectiveAt) ||
        (version.effectiveTo != null && ref.anchor.loggedAt >= +new Date(version.effectiveTo)))
    )
      reason ||= 'STOCK_CONFIG_CHANGED_DURING_WINDOW';
    if (!/^\d{1,64}$/.test(ref.anchor.accountNumber || '')) reason ||= 'STOCK_IDENTITY_UNKNOWN';
    files.add(ref.anchor.fileId);
    accounts.add(ref.anchor.accountNumber);
  }
  if (files.size !== 1) reason ||= 'STOCK_IDENTITY_CROSSES_FILES';
  if ([...submitted].some(account => !accounts.has(account)))
    reason ||= 'STOCK_SUBMISSION_NOT_OBSERVED';
  if (Number.isSafeInteger(denominator) && accounts.size > denominator)
    reason ||= 'STOCK_CONFIG_MISMATCH';
  return {
    stockDiagnostics: diagnostics,
    stockCount: reason ? null : accounts.size,
    stockReason: reason,
    stockAccounts: [...accounts].filter(Boolean).sort(),
    stockFrom: stock?.from ?? null,
    stockTo: stock?.to ?? null,
  };
}

module.exports = {
  configuration,
  contextEvents,
  collect,
  snapshot,
  refreshSnapshot,
  count,
  range,
  MAX_REFS,
};
