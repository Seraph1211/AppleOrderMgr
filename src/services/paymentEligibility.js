const ApiError = require('../utils/ApiError');
const PAYMENT_WINDOW_MS = 30 * 60 * 1000;
const PRECISE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const BLOCKED_STATUSES = new Set([
  'payment_received',
  'processing',
  'ready_for_pickup',
  'picked_up',
  'shipped',
  'delivered',
  'cancelled',
  'pickup_cancelled',
]);

/** 仅以精确来源下单时间计算付款截止，不回退官网或入库时间。 */
function getPaymentDeadline(order) {
  const value = order?.orderDate;
  if (!(value instanceof Date) && !PRECISE_TIME.test(value || '')) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time + PAYMENT_WINDOW_MS) : null;
}

/** 身份异常及状态待核实不拦截；保留明确已付、退款和终态限制。 */
function isAssignmentBlocked(order = {}, manual = false) {
  return (
    ['paid', 'refunded'].includes(order.paymentStatus) ||
    BLOCKED_STATUSES.has(order.status) ||
    (order.officialAllItemsTerminal === true && !(manual && order.status === 'payment_expired')) ||
    (!manual && order.status === 'payment_expired')
  );
}

/** 校验付款入口域名、协议和订单号，不依赖官网身份核验结果。 */
function validatePaymentOrderUrl(orderUrl, orderNumber) {
  try {
    const parsed = new URL(orderUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'www.apple.com.cn' ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parts[0] !== 'xc' ||
      parts[1] !== 'cn' ||
      parts[2] !== 'vieworder' ||
      parts[3]?.toUpperCase() !== String(orderNumber).toUpperCase() ||
      !parts[4]
    ) {
      throw new Error('invalid');
    }
  } catch (_error) {
    throw ApiError.conflict('订单付款链接无效', undefined, 'PAYMENT_LINK_INVALID');
  }
}

/** 生成预检及事务提交共用的逐条资格说明。 */
function assessAssignment(task, expectedVersion, now = new Date()) {
  const result = {
    id: Number(task?.id),
    orderId: task?.orderId || null,
    eligible: false,
    code: null,
    reason: null,
    solution: null,
    expired: false,
    warnings: [],
  };
  const reject = (code, reason, solution) => ({ ...result, code, reason, solution });
  if (!task) return reject('NOT_FOUND', '任务不存在', '重新加载任务列表');
  if (task.version !== expectedVersion)
    return reject('CONCURRENT_MODIFICATION', '任务已被更新', '重新加载后再选择任务');
  if (task.processingStatus === 'completed')
    return reject('INVALID_STATE', '任务已完成', '先重开任务再分配');
  const order = task.order || {};
  if (isAssignmentBlocked(order, true))
    return reject(
      'PAYMENT_NOT_ELIGIBLE',
      '订单已付款、退款、取消或已结束',
      '核对订单状态，此类订单无需分配付款'
    );
  const deadline = getPaymentDeadline(order);
  if (!deadline)
    return reject('UNKNOWN_DEADLINE', '来源下单时间缺失或不完整', '补全来源下单时间后重试');
  try {
    validatePaymentOrderUrl(order.orderUrl, order.orderNumber);
  } catch (_error) {
    return reject('PAYMENT_LINK_INVALID', '付款链接无效或订单号不匹配', '核对并修正原始订单链接');
  }
  result.expired = deadline <= now || order.status === 'payment_expired';
  if (!order.lastCrawledAt || order.officialStatusNeedsReview || order.status === 'unknown')
    result.warnings.push('官网状态尚未核实');
  if ((order.validationIssues || []).some(issue => issue.type === 'order_identity'))
    result.warnings.push('存在身份异常提示，请核对订单');
  return { ...result, eligible: true };
}

module.exports = {
  getPaymentDeadline,
  isAssignmentBlocked,
  validatePaymentOrderUrl,
  assessAssignment,
};
