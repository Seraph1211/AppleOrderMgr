const { createHash } = require('crypto');
const stores = require('../config/proxyStores.json');
const { resolveProductName } = require('../utils/productNaming');
const DIMENSIONS = ['city', 'model', 'color', 'capacity'];
/** 为结构化身份生成稳定摘要。 @param {*} value 白名单结构 @returns {string} SHA256摘要 */
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const known = value => Boolean(value && value !== '未知');

/** 按日志时刻排序；同文件使用真实字节顺序，跨文件同刻不猜因果。 @param {Object} a 事件 @param {Object} b 事件 @returns {number} 顺序 */
function compare(a, b) {
  const delta = +new Date(a.loggedAt) - +new Date(b.loggedAt);
  if (delta) return delta;
  if (a.fileId !== b.fileId) return 0;
  const offset = BigInt(a.byteOffset) - BigInt(b.byteOffset);
  return offset < 0n ? -1 : offset > 0n ? 1 : (a.lineIndex || 0) - (b.lineIndex || 0);
}

/** 只提取编号及设置白名单，不保存原文、账号身份或完整任务串。 @param {Object[]} rows 原日志 @returns {Object} 账号注册及稀疏事件 */
function parse(rows) {
  const accounts = new Map();
  const events = [];
  const gaps = [];
  const ignoredCity = [];
  const recordGap = (row, lineIndex = 0) => {
    const accountNumber =
      typeof row.accountNumber === 'string' && /^\d{1,64}$/.test(row.accountNumber)
        ? row.accountNumber
        : null;
    const at = row.loggedAt || null;
    const date = typeof row.businessDate === 'string' ? row.businessDate : '';
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000+08:00`) : NaN;
    const dated =
      Number.isFinite(day) && new Date(day + 8 * 3600000).toISOString().slice(0, 10) === date;
    // contextAt只继承前文排序时间，不能伪造无时间新启动的精确时刻。
    const atFrom = !at ? row.contextAt || (dated ? new Date(day).toISOString() : null) : null;
    const atTo = !at && dated ? new Date(day + 86400000 - 1).toISOString() : null;
    gaps.push({
      deviceId: row.deviceId,
      localId: row.localId,
      fileId: row.fileId,
      byteOffset: String(row.byteOffset),
      lineIndex,
      accountNumber,
      at,
      ...(!at ? { atFrom, atTo } : {}),
    });
    const firstAt = at || atFrom;
    if (accountNumber && firstAt && Number.isFinite(+new Date(firstAt))) {
      const id = digest([row.deviceId, row.localId, accountNumber]);
      if (!accounts.has(id) || +new Date(firstAt) < +new Date(accounts.get(id).firstSeenAt))
        accounts.set(id, {
          id,
          deviceId: row.deviceId,
          localId: row.localId,
          accountNumber,
          firstSeenAt: new Date(firstAt).toISOString(),
        });
    }
  };
  for (const row of rows) {
    if (row.parseState !== 'parsed' || row.partIndex !== 0) {
      if (
        row.partIndex === 0 &&
        (row.parseState === 'encoding_error' ||
          /开始监控库存状态|开始下单|消息(?:24093001|21101002)/.test(row.message))
      )
        recordGap(row);
      continue;
    }
    const lines = row.message.split(/\r?\n/);
    const multiple = lines.filter(Boolean).length > 1;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const match = lines[lineIndex]
        .replace(/^\uFEFF/, '')
        .match(
          /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+\[[^\]\r\n]*\]\[(\d{1,64})\]([^\r\n]*)$/
        );
      if (!match) {
        if (/开始监控库存状态|开始下单|消息(?:24093001|21101002)/.test(lines[lineIndex]))
          recordGap(row, lineIndex);
        continue;
      }
      const accountNumber = match[2];
      const loggedAt = new Date(`${match[1].replace(' ', 'T')}+08:00`);
      if (
        !Number.isFinite(+loggedAt) ||
        new Date(+loggedAt + 8 * 3600000).toISOString().slice(0, 23).replace('T', ' ') !== match[1]
      ) {
        if (/开始监控库存状态|开始下单|消息(?:24093001|21101002)/.test(lines[lineIndex]))
          recordGap(row, lineIndex);
        continue;
      }
      const key = digest([row.deviceId, row.localId, accountNumber]);
      if (!accounts.has(key) || +loggedAt < +new Date(accounts.get(key).firstSeenAt))
        accounts.set(key, {
          id: key,
          deviceId: row.deviceId,
          localId: row.localId,
          accountNumber,
          firstSeenAt: loggedAt.toISOString(),
        });
      const metadataConflict =
        !multiple && row.accountNumber != null && row.accountNumber !== accountNumber;
      const text = match[3].replace(/^[^\s-]*-/, '');
      let kind;
      let body = {};
      const numericStatus =
        /^消息21101002[ \t]*[:：][ \t]*[0-9]+[ \t]*,[ \t]*,[ \t]*,[ \t]*[0-9]+[ \t]*$/.test(text);
      if (numericStatus) {
        kind = 'city';
        body = { cities: [], unknown: true };
      } else if (/^开始监控库存状态/.test(text)) {
        kind = 'start';
        body = { mode: 'monitor', product: null };
      } else if (/^开始下单(?:\s|$)/.test(text)) {
        kind = 'start';
        const name = text
          .replace(/^开始下单\s*/, '')
          .replace(/\s*[(（][x×]\s*\d+[)）].*$/i, '')
          .trim();
        const product = resolveProductName(name);
        body = {
          mode: 'order',
          product: product.matched
            ? { model: product.modelName, color: product.color, capacity: product.capacity }
            : null,
        };
      } else if (/取货信息\s*[:：]\s*取货日期待付款完成后确定/.test(text)) {
        kind = 'signal';
      } else if (
        /消息(?:24093001|21101002)\s*[:：]/.test(text) ||
        (/无货|没有.*货/.test(text) &&
          (/\bR[A-Za-z0-9_-]+\b/.test(text) || stores.some(store => text.includes(store.name))))
      ) {
        kind = 'city';
        const codes = [...new Set(text.match(/\bR[A-Za-z0-9_-]+\b/g) || [])];
        const named = stores.filter(store => text.includes(store.name));
        const found = codes.map(code => stores.find(store => store.code === code));
        body = {
          cities: [...new Set([...found.filter(Boolean), ...named].map(store => store.city))],
          unknown: codes.some((_, index) => !found[index]) || (!codes.length && !named.length),
        };
      } else continue;
      if (metadataConflict) body = { ...body, invalid: 'ACCOUNT_METADATA_CONFLICT' };
      const event = {
        id: multiple ? `${row.id}:${lineIndex}` : row.id,
        deviceId: row.deviceId,
        localId: row.localId,
        accountNumber,
        fileId: row.fileId,
        byteOffset: String(row.byteOffset),
        lineIndex,
        loggedAt: loggedAt.toISOString(),
        kind,
        body,
      };
      (numericStatus ? ignoredCity : events).push({ ...event, payloadHash: digest(event) });
    }
  }
  return { accounts: [...accounts.values()], events, gaps, ignoredCity };
}

/** 查询日志时点的最近启动设置，停止不清空；缺失和冲突保留未知。 @param {Object[]} input 同编号事件 @param {number} at 截止毫秒 @returns {Object} 可证明维度 */
function resolveAccount(input, at) {
  const point = typeof at === 'object' ? at : null;
  const cutoff = point ? +new Date(point.loggedAt) : at;
  const events = input
    .filter(
      event =>
        +new Date(event.loggedAt) <= cutoff &&
        (!point ||
          +new Date(event.loggedAt) !== cutoff ||
          event.fileId !== point.fileId ||
          compare(event, point) <= 0) &&
        event.kind !== 'signal'
    )
    .sort(compare);
  const starts = events.filter(event => event.kind === 'start');
  const start = starts.at(-1);
  if (!start) return { reason: 'MISSING_START' };
  if (
    starts.some(
      event =>
        event.id !== start.id &&
        +new Date(event.loggedAt) === +new Date(start.loggedAt) &&
        event.fileId !== start.fileId
    )
  )
    return { reason: 'AMBIGUOUS_FILE_BOUNDARY' };
  const product = start.body.invalid ? null : start.body.product;
  const result = {
    ...(product || {}),
    startId: start.id,
    startAt: start.loggedAt,
    reason: product ? null : 'INCOMPLETE_SPEC',
  };
  const cityEvents = events.filter(
    event => event.kind === 'city' && +new Date(event.loggedAt) >= +new Date(start.loggedAt)
  );
  const after = cityEvents.filter(
    event => event.fileId === start.fileId && compare(event, start) >= 0
  );
  const cities = new Set();
  let unknown = false;
  for (const event of after) {
    if (event.body.unknown || event.body.invalid) unknown = true;
    for (const city of event.body.cities || []) cities.add(city);
  }
  const otherFiles = cityEvents.filter(event => event.fileId !== start.fileId);
  if (
    otherFiles.some(
      event =>
        event.body.unknown ||
        event.body.invalid ||
        (event.body.cities || []).some(city => !cities.has(city))
    )
  )
    unknown = true;
  if (!unknown && cities.size === 1) result.city = [...cities][0];
  else
    result.reason = unknown
      ? 'UNKNOWN_CITY_EVIDENCE'
      : cities.size > 1
        ? 'CONFLICTING_CITIES'
        : 'MISSING_CITY';
  return result;
}

/** 三值匹配：任一已知维度不同即可排除，可能匹配但有缺失不得当精确分母。 @param {Object[]} registries 账号宇宙 @param {Object[]} events 索引事件 @param {Object} scope 城市规格 @param {number} at 日志时点 @returns {Object} 分母候选及诊断 */
function population(registries, events, scope, at, prepared) {
  const cutoff = typeof at === 'object' ? +new Date(at.loggedAt) : at;
  const byAccount = prepared || new Map();
  for (const event of prepared ? [] : events) {
    if (!byAccount.has(event.accountNumber)) byAccount.set(event.accountNumber, []);
    byAccount.get(event.accountNumber).push(event);
  }
  const members = [];
  const unknownAccounts = [];
  const reasons = new Set();
  for (const registry of registries) {
    if (+new Date(registry.firstSeenAt) > cutoff) continue;
    const config = resolveAccount(byAccount.get(registry.accountNumber) || [], at);
    if (DIMENSIONS.some(key => known(config[key]) && config[key] !== scope[key])) continue;
    if (DIMENSIONS.every(key => known(config[key]) && known(scope[key])))
      members.push(registry.accountNumber);
    else {
      unknownAccounts.push(registry.accountNumber);
      reasons.add(config.reason || 'UNKNOWN_SCOPE');
    }
  }
  members.sort();
  return {
    complete: unknownAccounts.length === 0,
    members,
    unknownAccounts,
    reasons: [...reasons],
    digest: digest(members),
  };
}

module.exports = { parse, compare, resolveAccount, population, digest, DIMENSIONS };
