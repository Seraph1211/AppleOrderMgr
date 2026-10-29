const { performance } = require('perf_hooks');
const { Op, QueryTypes } = require('sequelize');
const policy = require('./aosTaskConfigPolicy');
const stockTasks = require('./aosStockTaskPolicy');

const READ_BUDGET_MS = 2000;
const READ_BUDGET_REASON = 'TASK_CONFIG_READ_BUDGET';

async function loadVersions(models, source, transaction, exhausted) {
  try {
    const read = async nested => {
      if (exhausted()) return READ_BUDGET_REASON;
      const instance = await models.MonitorInstance.findOne({
        where: { deviceId: source.deviceId, localId: source.localId },
        attributes: ['id'],
        transaction: nested,
      });
      if (!instance) return [];
      if (exhausted()) return READ_BUDGET_REASON;
      return models.AosTaskConfigVersion.findAll({
        where: {
          instanceId: instance.id,
          effectiveAt: { [Op.lte]: new Date(source.lastAt) },
          [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gt]: new Date(source.firstAt) } }],
        },
        attributes: ['id', 'effectiveAt', 'effectiveTo', 'aggregates'],
        order: [['effectiveAt', 'ASC']],
        limit: 101,
        transaction: nested,
        raw: true,
      });
    };
    if (!transaction || !models.sequelize?.transaction) return await read(transaction);
    return await models.sequelize.transaction({ transaction }, async nested => {
      try {
        const [setting] = await models.sequelize.query(
          "SELECT current_setting('statement_timeout') AS timeout",
          { type: QueryTypes.SELECT, transaction: nested }
        );
        await models.sequelize.query("SET LOCAL statement_timeout='1500ms'", {
          transaction: nested,
        });
        const rows = await read(nested);
        await models.sequelize.query("SELECT set_config('statement_timeout',:timeout,true)", {
          replacements: { timeout: setting.timeout },
          transaction: nested,
        });
        return rows;
      } catch (error) {
        throw new Error('TASK_CONFIG_READ_ISOLATED', { cause: error });
      }
    });
  } catch (_error) {
    return null;
  }
}

/** 从人工确认的有效配置读取分母，局部失败只省略比例，绝不阻塞放货通知。 @param {Object} tracker 观测引用 @param {Object} models 数据模型 @param {Object} transaction 事务 @returns {Promise<Object>} 任务比例快照 */
async function evaluate(tracker, models, transaction, options = {}) {
  try {
    const result = { version: 3, basis: 'configured_tasks', scopes: {} };
    if (!tracker) return { ...result, reason: 'TASK_TRACKER_MISSING' };
    const refs = (tracker.refs || []).slice(0, 10000);
    const groups = new Map();
    const sources = new Map();
    for (const ref of refs) {
      const key = policy.scopeKey(ref.item);
      const sourceKey = ref.item.source?.key || `${ref.anchor.deviceId}:${ref.anchor.localId}`;
      const groupKey = `${key}:${sourceKey}`;
      if (!groups.has(groupKey))
        groups.set(groupKey, { key, sourceKey, scope: ref.item, refs: [] });
      groups.get(groupKey).refs.push(ref);
      const source = sources.get(sourceKey) || {
        deviceId: ref.anchor.deviceId,
        localId: ref.anchor.localId,
        firstAt: Infinity,
        lastAt: -Infinity,
      };
      source.firstAt = Math.min(source.firstAt, ref.anchor.loggedAt);
      source.lastAt = Math.max(source.lastAt, ref.anchor.loggedAt);
      sources.set(sourceKey, source);
    }
    // 同范围只有检测、没有提交的来源也展示0/N/D；不增加原始命中和门店次数。
    const scopes = new Set([...groups.values()].map(group => group.key));
    for (const stock of tracker.stock?.refs || []) {
      if (stock.reason) continue;
      const key = policy.scopeKey(stock.item);
      if (!scopes.has(key)) continue;
      const sourceKey =
        stock.item.source?.key || `${stock.anchor.deviceId}:${stock.anchor.localId}`;
      const groupKey = `${key}:${sourceKey}`;
      if (!groups.has(groupKey))
        groups.set(groupKey, {
          key,
          sourceKey,
          scope: stock.item,
          anchor: stock.anchor,
          refs: [],
        });
      const source = sources.get(sourceKey) || {
        deviceId: stock.anchor.deviceId,
        localId: stock.anchor.localId,
        firstAt: Infinity,
        lastAt: -Infinity,
      };
      source.firstAt = Math.min(source.firstAt, stock.anchor.loggedAt);
      source.lastAt = Math.max(source.lastAt, stock.anchor.loggedAt);
      sources.set(sourceKey, source);
    }
    const loaded = new Map();
    // 每个来源只查一次；10000引用上限与500范围上限和原窗口一致。
    if (sources.size > 500) return { ...result, reason: 'TASK_SCOPE_LIMIT' };
    // 单次计算共用单调时钟预算，避免大量来源各耗1500ms拖住通知事务。
    const clock = options.monotonicNow || (() => performance.now());
    const deadline = clock() + READ_BUDGET_MS;
    const exhausted = () => clock() >= deadline;
    for (const [key, source] of sources) {
      if (exhausted()) loaded.set(key, READ_BUDGET_REASON);
      else loaded.set(key, await loadVersions(models, source, transaction, exhausted));
    }
    tracker.taskSnapshots ||= {};
    for (const [groupKey, group] of groups) {
      const numbers = new Set(group.refs.map(ref => ref.anchor.accountNumber));
      const times = group.refs.length
        ? group.refs.map(ref => ref.anchor.loggedAt)
        : stockTasks.range(tracker.stock, group);
      const firstAt = Math.min(...times);
      const lastAt = Math.max(...times);
      let reason =
        tracker.incomplete ||
        (tracker.overflow || (tracker.refs || []).length > 10000
          ? 'TASK_REFERENCE_LIMIT'
          : tracker.associationOverflow
            ? 'TASK_ASSOCIATION_INCOMPLETE'
            : groups.size > 500
              ? 'TASK_SCOPE_LIMIT'
              : null);
      if ([...numbers].some(value => typeof value !== 'string' || !/^\d{1,64}$/.test(value)))
        reason ||= 'TASK_IDENTITY_UNKNOWN';
      // 跨日志文件不能证明编号未重置：仅该来源/范围降级。
      if (group.refs.length && new Set(group.refs.map(ref => ref.anchor.fileId)).size !== 1)
        reason ||= 'TASK_IDENTITY_CROSSES_FILES';
      const versions = loaded.get(group.sourceKey);
      let version = null;
      if (versions === READ_BUDGET_REASON) reason ||= READ_BUDGET_REASON;
      else if (!versions) reason ||= 'TASK_CONFIG_READ_FAILED';
      else if (versions.length > 100) reason ||= 'TASK_VERSION_LIMIT';
      else {
        const matched = versions.filter(
          row =>
            +new Date(row.effectiveAt) <= firstAt &&
            (row.effectiveTo == null || +new Date(row.effectiveTo) > lastAt)
        );
        if (matched.length === 1) version = matched[0];
        else
          reason ||= versions.length ? 'TASK_CONFIG_CHANGED_DURING_WINDOW' : 'TASK_CONFIG_MISSING';
      }
      const aggregate = version?.aggregates?.find(row => policy.scopeKey(row) === group.key);
      const denominator = aggregate?.taskCount ?? 0;
      if (version && (!Number.isSafeInteger(denominator) || denominator < numbers.size))
        reason ||= 'TASK_CONFIG_MISMATCH';
      if (version && !denominator) reason ||= 'TASK_CONFIG_SCOPE_MISSING';
      const frozen = tracker.taskSnapshots[groupKey];
      if (frozen && (frozen.versionId !== version?.id || frozen.denominator !== denominator))
        reason ||= 'TASK_FROZEN_VERSION_CHANGED';
      if (!reason && !frozen)
        tracker.taskSnapshots[groupKey] = { versionId: version.id, denominator };
      result.scopes[group.key] ||= {
        city: group.scope.city,
        model: group.scope.model,
        color: group.scope.color,
        capacity: group.scope.capacity,
        sources: {},
      };
      result.scopes[group.key].sources[group.sourceKey] = {
        ...stockTasks.count(tracker.stock, group, numbers, reason ? null : denominator, version),
        numerator: reason ? null : numbers.size,
        denominator: reason ? null : denominator,
        reason,
        versionId: version?.id || null,
        source: group.scope.source,
        firstAt,
        lastAt,
      };
    }
    return result;
  } catch (_error) {
    return {
      version: 3,
      basis: 'configured_tasks',
      scopes: {},
      reason: 'TASK_RATIO_EVALUATION_FAILED',
    };
  }
}
module.exports = { evaluate, READ_BUDGET_MS };
