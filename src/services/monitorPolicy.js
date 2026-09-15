const ApiError = require('../utils/ApiError');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MINUTE_MS = 60000;
/**
 * 验证有界整数。
 * @param {number} value 待校验整数
 * @param {number} min 下界
 * @param {number} max 上界
 * @returns {number} 处理结果
 */
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw ApiError.badRequest('整数超出范围');
  return value;
}
/**
 * 验证监控资源 UUID。
 * @param {string} value UUID
 * @returns {string} 处理结果
 */
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw ApiError.badRequest('资源标识无效');
  return value;
}
/**
 * 验证短文本，不输出输入值。
 * @param {string} value 文本
 * @param {number} max 最大长度
 * @param {boolean} empty 是否允许空值
 * @returns {string} 处理结果
 */
function shortText(value, max, empty = false) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim()) ||
    [...value].some(c => c.charCodeAt(0) < 32 && !['\n', '\t', '\r'].includes(c))
  )
    throw ApiError.badRequest('文本格式无效');
  return value.trim();
}
/**
 * 严格验证对象字段。
 * @param {Object} value 请求对象
 * @param {string[]} allowed 允许字段
 * @returns {void} 处理结果
 */
function fields(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(k => !allowed.includes(k))
  )
    throw ApiError.badRequest('请求字段无效');
}
/**
 * 验证规则，不接受运行代码或正则。
 * @param {Object} value 规则配置
 * @returns {Object} 处理结果
 */
function validateRule(value) {
  fields(value, [
    'name',
    'enabled',
    'mode',
    'keywords',
    'excludes',
    'windowMinutes',
    'threshold',
    'severity',
    'deviceIds',
    'directoryIds',
  ]);
  const textList = (list, required) => {
    if (!Array.isArray(list) || list.length > 20 || (required && !list.length))
      throw ApiError.badRequest('关键词数量无效');
    return [...new Set(list.map(x => shortText(x, 100)))];
  };
  const ids = list => {
    if (!Array.isArray(list) || list.length > 100) throw ApiError.badRequest('范围数量无效');
    return [...new Set(list.map(uuid))];
  };
  if (
    typeof value.enabled !== 'boolean' ||
    !['any', 'all'].includes(value.mode) ||
    !['info', 'warning', 'critical'].includes(value.severity)
  )
    throw ApiError.badRequest('规则选项无效');
  return {
    name: shortText(value.name, 100),
    enabled: value.enabled,
    mode: value.mode,
    keywords: textList(value.keywords, true),
    excludes: textList(value.excludes, false),
    windowMinutes: integer(value.windowMinutes, 1, 60),
    threshold: integer(value.threshold, 1, 100000),
    severity: value.severity,
    deviceIds: ids(value.deviceIds),
    directoryIds: ids(value.directoryIds),
  };
}
/**
 * 与采集器保持一致的区分大小写字面匹配。
 * @param {Object} rule 规则配置
 * @param {string} text 单条日志
 * @returns {boolean} 处理结果
 */
function matches(rule, text) {
  return (
    !rule.excludes.some(k => text.includes(k)) &&
    (rule.mode === 'all'
      ? rule.keywords.every(k => text.includes(k))
      : rule.keywords.some(k => text.includes(k)))
  );
}
/**
 * 判断规则适用实例。
 * @param {Object} rule 规则
 * @param {string} deviceId 设备UUID
 * @param {string} localId 本地实例UUID
 * @returns {boolean} 处理结果
 */
function applies(rule, deviceId, localId) {
  return (
    rule.enabled &&
    (!rule.deviceIds.length || rule.deviceIds.includes(deviceId)) &&
    (!rule.directoryIds.length || rule.directoryIds.includes(localId))
  );
}
/**
 * 根据有效新报告推进告警；未知状态不得恢复。
 * @param {Object|null} alert 当前告警
 * @param {Object} rule 规则
 * @param {number} count 窗口次数
 * @param {Date|string} observedAt 观测时间
 * @param {boolean} valid 检测是否有效
 * @returns {Object|null} 处理结果
 */
function transition(alert, rule, count, observedAt, valid) {
  if (!valid) return null;
  if (count >= rule.threshold)
    return {
      status: 'active',
      hitCount: count,
      quietChecks: 0,
      lastSeenAt: observedAt,
      recoveredAt: null,
    };
  if (!alert || alert.status !== 'active') return null;
  const quietChecks = alert.quietChecks + 1;
  return {
    quietChecks,
    hitCount: count,
    ...(quietChecks >= 2 ? { status: 'recovered', recoveredAt: observedAt } : {}),
  };
}
/**
 * 获取静默及新鲜度状态，过期数据不生成待提醒。
 * @param {Object} instance 实例快照
 * @param {Date} now 当前时间
 * @returns {Object} 处理结果
 */
function displayState(instance, now = new Date()) {
  const data = instance.snapshot || {};
  const fresh = instance.observedAt && now - new Date(instance.observedAt) <= 2 * MINUTE_MS;
  const muted = new Date(instance.handling?.until || 0) > now;
  return {
    fresh: !!fresh,
    muted,
    state: !instance.active ? 'removed' : !fresh ? 'offline' : data.state || 'unknown',
    actionable: !!(instance.active && fresh && !muted && data.state === 'ready'),
  };
}
/**
 * 验证北京时间日期范围。
 * @param {string} from 开始日期
 * @param {string} to 结束日期
 * @returns {Object} 处理结果
 */
function dateRange(from, to) {
  for (const value of [from, to])
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(+new Date(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw ApiError.badRequest('日期无效');
  const start = new Date(`${from}T00:00:00+08:00`);
  const end = new Date(new Date(`${to}T00:00:00+08:00`).getTime() + 86400000);
  if (end <= start || end - start > 90 * 86400000) throw ApiError.badRequest('最多查询90天');
  return { start, end };
}
module.exports = {
  integer,
  uuid,
  shortText,
  fields,
  validateRule,
  matches,
  applies,
  transition,
  displayState,
  dateRange,
};
