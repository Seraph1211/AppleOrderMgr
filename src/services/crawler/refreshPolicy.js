const AUTO_STOP_STATUSES = new Set(['completed', 'delivered', 'cancelled', 'pickup_cancelled']);
const PAID_STATUSES = new Set(['paid', 'refunded']);
const AUTO_REFRESH_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 90_000;

const REFRESH_PRIORITIES = new Map([
  ['manual_single', 400],
  ['overdue_auto', 300],
  ['auto', 250],
  ['page_open', 200],
  ['manual_all', 100],
]);

/**
 * 判断订单是否应进入未付款自动刷新。
 * @param {Object} orderLike - 订单实例或普通对象
 * @returns {boolean} 是否需要自动刷新
 */
function isAutoRefreshEligible(orderLike) {
  const order = typeof orderLike?.toJSON === 'function' ? orderLike.toJSON() : orderLike || {};
  if (!order.orderUrl || order.autoRefreshEnabled === false) return false;
  if (order.validationStatus === 'abnormal') return false;
  if (AUTO_STOP_STATUSES.has(order.status)) return false;
  return !PAID_STATUSES.has(String(order.paymentStatus || '').toLowerCase());
}

/**
 * 计算下一次自动刷新时间。
 * @param {Object} orderLike - 订单数据
 * @param {Date} from - 基准时间
 * @returns {Date|null} 下一次时间；不符合资格时为 null
 */
function getNextAutoRefreshAt(orderLike, from = new Date()) {
  return isAutoRefreshEligible(orderLike)
    ? new Date(new Date(from).getTime() + AUTO_REFRESH_INTERVAL_MS)
    : null;
}

/**
 * 获取触发类型优先级。
 * @param {string} trigger - 触发类型
 * @param {boolean} overdue - 自动任务是否已经超时
 * @returns {number} 优先级
 */
function getRefreshPriority(trigger, overdue = false) {
  if (trigger === 'auto' && overdue) return REFRESH_PRIORITIES.get('overdue_auto');
  return REFRESH_PRIORITIES.get(trigger) || REFRESH_PRIORITIES.get('manual_all');
}

/**
 * 计算对外展示的新鲜度。
 * @param {Object|null} scheduleLike - 调度状态
 * @param {Object} orderLike - 订单状态
 * @param {Date} now - 当前时间
 * @returns {string} fresh/stale/refreshing/failed
 */
function getDisplayedFreshness(scheduleLike, orderLike, now = new Date()) {
  const schedule = scheduleLike?.toJSON ? scheduleLike.toJSON() : scheduleLike || {};
  if (schedule.freshnessStatus === 'refreshing') return 'refreshing';
  if (schedule.freshnessStatus === 'failed') return 'failed';
  if (!schedule.lastSuccessAt) return 'stale';
  if (
    isAutoRefreshEligible(orderLike) &&
    new Date(now).getTime() - new Date(schedule.lastSuccessAt).getTime() > STALE_AFTER_MS
  ) {
    return 'stale';
  }
  return schedule.freshnessStatus || 'fresh';
}

module.exports = {
  AUTO_REFRESH_INTERVAL_MS,
  STALE_AFTER_MS,
  REFRESH_PRIORITIES,
  isAutoRefreshEligible,
  getNextAutoRefreshAt,
  getRefreshPriority,
  getDisplayedFreshness,
};
