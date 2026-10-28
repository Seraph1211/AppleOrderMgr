const configPolicy = require('./aosAccountConfigPolicy');
const configs = require('./aosAccountConfigService');
const MAX_RATIO_REFS = 10000;
const MAX_RATIO_SCOPES = 500;
/** 生成城市及完整规格范围键。 @param {Object} item 关联维度 @returns {string} 稳定范围摘要 */
const scopeKey = item => configPolicy.digest([item.city, item.model, item.color, item.capacity]);

/** 独立于1000条关联引用保存账号hit；超限只令比例未知，原命中数不变。 @param {Object|null} previous 旧跟踪 @param {Object} anchor 信号 @param {Object} item 关联维度 @returns {Object} 新跟踪 */
function add(previous, anchor, item) {
  const tracker = previous || { version: 1, refs: [], snapshots: {}, overflow: false };
  if (tracker.refs.length >= MAX_RATIO_REFS) {
    tracker.overflow = true;
    return tracker;
  }
  tracker.refs.push({ anchor: { ...anchor }, item: structuredClone(item) });
  return tracker;
}

/** 仅依据已核实重关联更新scope，不从未来配置改写signal原始商品。 @param {Object} tracker 跟踪 @param {Object} association 关联 @returns {Object} 跟踪 */
function refresh(tracker, association) {
  if (!tracker) return null;
  const next = structuredClone(tracker);
  const items = new Map((association?.refs || []).map(ref => [ref.anchor.id, ref.item]));
  for (const ref of next.refs)
    if (items.has(ref.anchor.id)) ref.item = structuredClone(items.get(ref.anchor.id));
  next.associationOverflow = Boolean(association?.overflowCount);
  return next;
}

/** 根据首hit时点冻结分母，逐hit验证eligible集合；异常只降级比例，不吞分子。 @param {Object} tracker 独立跟踪 @param {Object} models 模型 @param {Object} transaction 事务 @returns {Promise<Object>} 城市规格来源比例 */
async function evaluate(tracker, models, transaction) {
  try {
    if (models.AosTaskConfigVersion)
      return require('./aosTaskRatioService').evaluate(tracker, models, transaction);
    const result = {
      version: 1,
      scopes: {},
      ...(tracker?.incomplete ? { reason: tracker.incomplete } : {}),
    };
    if (!tracker) return result;
    const sources = new Map();
    const groups = new Map();
    for (const ref of tracker.refs) {
      const item = ref.item;
      const key = scopeKey(item);
      const sourceKey = item.source?.key || `${ref.anchor.deviceId}:${ref.anchor.localId}`;
      const groupKey = `${key}:${sourceKey}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { key, sourceKey, scope: item, refs: [] });
      groups.get(groupKey).refs.push(ref);
      const old = sources.get(sourceKey) || {
        deviceId: ref.anchor.deviceId,
        localId: ref.anchor.localId,
        firstAt: Infinity,
        lastAt: 0,
      };
      old.firstAt = Math.min(old.firstAt, ref.anchor.loggedAt);
      old.lastAt = Math.max(old.lastAt, ref.anchor.loggedAt);
      sources.set(sourceKey, old);
    }
    tracker.snapshots ||= {};
    const loaded = new Map();
    for (const [key, source] of sources)
      loaded.set(
        key,
        await configs.load(models, source, source.firstAt, source.lastAt, transaction)
      );
    const scopedCount = new Set([...groups.values()].map(group => group.key)).size;
    for (const [groupKey, group] of groups) {
      const { key, sourceKey, scope, refs } = group;
      const sorted = [...refs].sort((a, b) => configPolicy.compare(a.anchor, b.anchor));
      const firstAt = sorted[0].anchor.loggedAt;
      const lastAt = Math.max(...sorted.map(ref => ref.anchor.loggedAt));
      const accounts = new Set(
        refs
          .map(ref => ref.anchor.accountNumber)
          .filter(value => typeof value === 'string' && /^\d{1,64}$/.test(value))
      );
      const missingAccount = refs.some(ref => !ref.anchor.accountNumber);
      const data = loaded.get(sourceKey);
      let reason =
        tracker.incomplete ||
        (tracker.overflow
          ? 'RATIO_REFERENCE_LIMIT'
          : scopedCount > MAX_RATIO_SCOPES
            ? 'RATIO_SCOPE_LIMIT'
            : tracker.associationOverflow
              ? 'ASSOCIATION_REFERENCE_LIMIT'
              : missingAccount
                ? 'SIGNAL_ACCOUNT_UNKNOWN'
                : !data.ready
                  ? data.reason
                  : null);
      const prepared = new Map();
      for (const event of data.events) {
        if (!prepared.has(event.accountNumber)) prepared.set(event.accountNumber, []);
        prepared.get(event.accountNumber).push(event);
      }
      const cache = new Map();
      const times = [
        ...new Set([
          ...data.events.map(event => +new Date(event.loggedAt)),
          ...data.registries.map(row => +new Date(row.firstSeenAt)),
        ]),
      ].sort((a, b) => a - b);
      const membership = ref => {
        let lo = 0;
        let hi = times.length;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (times[mid] <= ref.anchor.loggedAt) lo = mid + 1;
          else hi = mid;
        }
        const time = times[lo - 1] ?? -1;
        const cacheKey =
          time === ref.anchor.loggedAt
            ? `${time}:${ref.anchor.fileId}:${ref.anchor.byteOffset}:${ref.anchor.lineIndex || 0}`
            : String(time);
        if (!cache.has(cacheKey))
          cache.set(
            cacheKey,
            configPolicy.population(data.registries, data.events, scope, ref.anchor, prepared)
          );
        return cache.get(cacheKey);
      };
      const baseline = membership(sorted[0]);
      if (!baseline.complete) reason ||= baseline.reasons.join('|') || 'INCOMPLETE_CONFIG';
      const frozen = tracker.snapshots[groupKey];
      if (frozen && (frozen.firstAt !== firstAt || frozen.digest !== baseline.digest))
        reason ||= 'FROZEN_POPULATION_CHANGED';
      if (!reason && !frozen)
        tracker.snapshots[groupKey] = {
          firstAt,
          digest: baseline.digest,
          denominator: baseline.members.length,
        };
      for (const ref of sorted) {
        const pop = membership(ref);
        if (!pop.complete) reason ||= 'CONFIG_INCOMPLETE_DURING_WINDOW';
        else if (pop.digest !== baseline.digest) reason ||= 'POPULATION_CHANGED_DURING_WINDOW';
        if (ref.anchor.accountNumber && !pop.members.includes(ref.anchor.accountNumber))
          reason ||= 'HIT_NOT_ELIGIBLE_AT_TIME';
        if (data.gapOverflow) reason ||= 'CONFIG_GAP_LIMIT';
        for (const gap of data.gaps || []) {
          const from = gap.atFrom || gap.at;
          const to = gap.atTo || gap.at;
          const earliest = from && Number.isFinite(+new Date(from)) ? +new Date(from) : null;
          const latest = to && Number.isFinite(+new Date(to)) ? +new Date(to) : null;
          if (earliest != null && earliest > ref.anchor.loggedAt) continue;
          const affects = data.registries.some(registry => {
            if (gap.accountNumber && registry.accountNumber !== gap.accountNumber) return false;
            const config = configPolicy.resolveAccount(
              prepared.get(registry.accountNumber) || [],
              ref.anchor
            );
            const complete = configPolicy.DIMENSIONS.every(
              field => config[field] && config[field] !== '未知'
            );
            // 未被之后完整启动覆盖的gap可能改变旧SKU/城市，旧维度不能排除影响。
            return (
              latest == null || !complete || !config.startAt || +new Date(config.startAt) <= latest
            );
          });
          if (affects) reason ||= 'CONFIG_GAP_UNRESOLVED';
        }
      }
      const numerator =
        missingAccount ||
        tracker.incomplete ||
        tracker.overflow ||
        tracker.associationOverflow ||
        scopedCount > MAX_RATIO_SCOPES
          ? null
          : accounts.size;
      const denominator =
        !reason && baseline.members.length >= accounts.size ? baseline.members.length : null;
      if (!reason && denominator == null) reason = 'NUMERATOR_EXCEEDS_DENOMINATOR';
      if (!result.scopes[key])
        result.scopes[key] = {
          city: scope.city,
          model: scope.model,
          color: scope.color,
          capacity: scope.capacity,
          sources: {},
        };
      result.scopes[key].sources[sourceKey] = {
        numerator,
        denominator,
        reason,
        firstAt,
        lastAt,
        coverage: data.coverage || null,
      };
    }
    return result;
  } catch (_error) {
    return { version: 1, scopes: {}, reason: 'RATIO_EVALUATION_FAILED' };
  }
}
module.exports = { add, refresh, evaluate, scopeKey, MAX_RATIO_REFS, MAX_RATIO_SCOPES };
