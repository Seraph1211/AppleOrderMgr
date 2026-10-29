const { createHash } = require('crypto');

const CONTENT_BYTES = 1520;
const UNKNOWN = '未知';
const BEIJING_OFFSET_MS = 8 * 3600000;
const bytes = text => Buffer.byteLength(text, 'utf8');
const count = value =>
  Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
const field = value => String(value || UNKNOWN);
const sum = rows => rows.reduce((total, row) => total + row.count, 0);

function shorten(value, size) {
  const chars = [
    ...field(value)
      .replace(/[\r\n\t]+/g, ' ')
      .trim(),
  ];
  return chars.length > size ? `${chars.slice(0, size).join('')}…` : chars.join('');
}

function hasLocation(row) {
  return ['city', 'storeCode', 'storeName'].every(key => row[key] && row[key] !== UNKNOWN);
}

function serverName(value) {
  const name = field(value);
  const number = name.match(/^US(?:[\s_]*Server)?(?:[\s_]*(?:No\.?|#))?[\s_]*(\d+)$/i)?.[1];
  return number ? `US_${number.padStart(2, '0')}` : name;
}

function timeRange(rows) {
  const timestamps = rows
    .flatMap(row => [row.firstAt, row.lastAt])
    .filter(
      value => Number.isFinite(value) && Number.isFinite(+new Date(value + BEIJING_OFFSET_MS))
    );
  if (!timestamps.length) return '';
  const clock = value =>
    new Date(value + BEIJING_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
  const first = clock(Math.min(...timestamps));
  const last = clock(Math.max(...timestamps));
  const crossYear = first.slice(0, 4) !== last.slice(0, 4);
  const start = crossYear ? first : first.slice(5);
  if (first === last) return `时间：${start}`;
  let end = crossYear ? last : last.slice(5);
  if (first.slice(0, 10) === last.slice(0, 10)) end = last.slice(11);
  return `时间：${start}～${end}`;
}

function scopesFor(rows) {
  const scopes = new Map();
  for (const row of rows) {
    const identity = ['city', 'model', 'color', 'capacity'].map(key => field(row[key]));
    const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    if (!scopes.has(key)) scopes.set(key, { key, ...row, stores: new Map(), sources: new Map() });
    const scope = scopes.get(key);
    const storeKey = hasLocation(row)
      ? `store:${row.storeCode}`
      : JSON.stringify([row.city, row.storeCode, row.storeName]);
    if (!scope.stores.has(storeKey)) scope.stores.set(storeKey, { ...row, count: 0, groups: 0 });
    const store = scope.stores.get(storeKey);
    store.count += row.count;
    store.groups += 1;
    for (const [sourceKey, value] of Object.entries(row.sources || {})) {
      if (!scope.sources.has(sourceKey))
        scope.sources.set(sourceKey, { ...value, key: sourceKey, count: 0 });
      // 此处仅累计原日志命中数，用于省略说明；账号比例绝不跨门店求和。
      scope.sources.get(sourceKey).count += count(value.count);
    }
  }
  return [...scopes.values()].map(scope => ({
    ...scope,
    stores: [...scope.stores.values()],
    sources: [...scope.sources.values()],
  }));
}

const numberText = value => (Number.isSafeInteger(value) && value >= 0 ? String(value) : '—');

function sourceLine(source, scope, ratios) {
  const ratio = [1, 2, 3].includes(ratios?.version)
    ? ratios.scopes?.[scope.key]?.sources?.[source.key]
    : null;
  const numerator = ratio?.numerator;
  const denominator = ratio?.denominator;
  const inconsistent =
    Number.isFinite(numerator) && Number.isFinite(denominator) && numerator > denominator;
  const label = `${shorten(serverName(source.server), 12)} / ${shorten(source.instance, 10)}`;
  if ([2, 3].includes(ratios?.version)) {
    if (
      inconsistent ||
      !Number.isSafeInteger(numerator) ||
      !Number.isSafeInteger(denominator) ||
      denominator <= 0 ||
      ratio.reason
    )
      return `${label}｜${count(source.count)}次命中`;
    if (ratios.version === 3) {
      const stock = ratio.stockCount;
      const invalidStock =
        ratio.stockReason ||
        !Number.isSafeInteger(stock) ||
        stock < numerator ||
        stock > denominator;
      return `${label}｜${numerator}/${numberText(invalidStock ? null : stock)}/${denominator}`;
    }
    return `${label}｜同城任务 ${numerator}/${denominator}`;
  }
  return `${label}｜${numberText(numerator)}/${numberText(inconsistent ? null : denominator)}`;
}

function storeMarker(rows) {
  if (!rows.length) return '';
  return `其余${rows.reduce((total, row) => total + row.groups, 0)}组｜${sum(rows)}次未展示`;
}

function sourceMarker(rows) {
  return rows.length ? `其余${rows.length}个来源｜${sum(rows)}次未展示` : '';
}

function scopeText(scope, ratios, storeLimit, sourceLimit) {
  const lines = [
    `${shorten(scope.model, 24)} · ${shorten(scope.color, 20)} · ${shorten(scope.capacity, 12)}`,
  ];
  for (const row of scope.stores.slice(0, storeLimit)) {
    const name = row.storeName && row.storeName !== UNKNOWN ? row.storeName : '门店未知';
    lines.push(`${shorten(row.city, 12)} · ${shorten(name, 30)}｜${row.count}次`);
  }
  const omittedStores = storeMarker(scope.stores.slice(storeLimit));
  if (omittedStores) lines.push(omittedStores);
  for (const source of scope.sources.slice(0, sourceLimit))
    lines.push(sourceLine(source, scope, ratios));
  if (!scope.sources.length)
    lines.push([2, 3].includes(ratios?.version) ? '未知来源' : '未知来源｜—/—');
  const omittedSources = sourceMarker(scope.sources.slice(sourceLimit));
  if (omittedSources) lines.push(omittedSources);
  return lines.join('\n');
}

function remainingMarker(scopes) {
  return storeMarker(scopes.flatMap(scope => scope.stores));
}

/**
 * 按城市及完整规格展示三分钟命中与独立账号比例，保留完整总计及明确省略说明。
 * @param {Object} groups 原有 aosGroups；仅原日志命中数参与累计。
 * @param {Object} ratios 以城市、机型、颜色、容量散列索引的来源比例快照。
 * @returns {string} 无标题、URL及尾换行的纯文本正文，UTF-8不超过1520字节。
 */
function formatSummary(groups, ratios) {
  const rows = Object.values(groups || {})
    .filter(row => row && typeof row === 'object')
    .map(row => ({ ...row, count: count(row.count) }));
  const knownStores = new Set(rows.filter(hasLocation).map(row => row.storeCode));
  const unknown = sum(rows.filter(row => !hasLocation(row)));
  const location = unknown
    ? `${knownStores.size}家已知门店｜${unknown}次门店未知`
    : `${knownStores.size}家门店`;
  const blocks = [`3分钟汇总｜${sum(rows)}次命中｜${location}`];
  const time = timeRange(rows);
  const scopes = scopesFor(rows);
  if (ratios?.version === 3) {
    for (const scope of scopes) {
      for (const [key, ratio] of Object.entries(ratios.scopes?.[scope.key]?.sources || {})) {
        if (!scope.sources.some(source => source.key === key) && ratio.source)
          scope.sources.push({ ...ratio.source, key, count: 0 });
      }
    }
  }
  const render = (extra, omitted) => [...blocks, extra, omitted, time].filter(Boolean).join('\n\n');
  for (const [index, scope] of scopes.entries()) {
    const remaining = remainingMarker(scopes.slice(index + 1));
    const full = scopeText(scope, ratios, scope.stores.length, scope.sources.length);
    if (bytes(render(full, remaining)) <= CONTENT_BYTES) {
      blocks.push(full);
      continue;
    }
    // 先保证第一家门店和第一个来源同时出现，再扩展门店与来源；余项明确省略。
    let stores = 1;
    let sources = Math.min(1, scope.sources.length);
    const fits = () =>
      bytes(render(scopeText(scope, ratios, stores, sources), remaining)) <= CONTENT_BYTES;
    if (!fits()) {
      blocks.push(remainingMarker(scopes.slice(index)));
      break;
    }
    while (stores < scope.stores.length) {
      stores += 1;
      if (!fits()) {
        stores -= 1;
        break;
      }
    }
    while (sources < scope.sources.length) {
      sources += 1;
      if (!fits()) {
        sources -= 1;
        break;
      }
    }
    blocks.push(scopeText(scope, ratios, stores, sources));
    if (remaining) blocks.push(remaining);
    break;
  }
  if (time) blocks.push(time);
  return blocks.filter(Boolean).join('\n\n');
}

module.exports = { formatSummary };
