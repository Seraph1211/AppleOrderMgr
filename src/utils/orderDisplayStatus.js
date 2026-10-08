const { getPaymentDeadline } = require('../services/paymentEligibility');

const DISPLAY_ORDER_STATUSES = Object.freeze([
  'unknown',
  'confirmed',
  'payment_timeout',
  'processing',
  'ready_for_pickup',
  'picked_up',
  'partially_cancelled',
  'cancelled',
  'expired',
]);

/* eslint-disable camelcase -- 键名沿用 API 状态码 */
const DISPLAY_ORDER_STATUS_LABELS = Object.freeze({
  unknown: '待确认',
  confirmed: '订单已确认',
  payment_timeout: '付款超时',
  processing: '处理中',
  ready_for_pickup: '可取货',
  picked_up: '已取货',
  partially_cancelled: '部分取消',
  cancelled: '已取消',
  expired: '已过期',
});
/* eslint-enable camelcase */

/**
 * 将订单管理展示状态转换为与页面一致的中文名称。
 * @param {string} status - 展示状态码
 * @returns {string} 中文状态名称，未知值显示待确认
 */
function getDisplayOrderStatusLabel(status) {
  return Object.hasOwn(DISPLAY_ORDER_STATUS_LABELS, status)
    ? DISPLAY_ORDER_STATUS_LABELS[status]
    : DISPLAY_ORDER_STATUS_LABELS.unknown;
}

// 列表筛选与展示使用同一来源时间和邮件付款证据；不改写邮件生命周期。
const DISPLAY_ORDER_STATUS_SQL = `CASE WHEN "Order"."email_order_status" = 'confirmed'
  AND "Order"."email_payment_status" <> 'paid'
  AND "Order"."order_date" IS NOT NULL
  AND "Order"."order_date" + INTERVAL '30 minutes' <= CURRENT_TIMESTAMP
  THEN 'payment_timeout' ELSE "Order"."email_order_status" END`;

/** 从邮件阶段、付款证据和来源下单时间派生订单管理展示状态。 */
function getDisplayOrderStatus(order, now = new Date()) {
  const status = order?.emailOrderStatus || 'unknown';
  if (status !== 'confirmed' || order?.emailPaymentStatus === 'paid') return status;
  const deadline = getPaymentDeadline(order);
  return deadline && deadline <= now ? 'payment_timeout' : status;
}

module.exports = {
  DISPLAY_ORDER_STATUSES,
  DISPLAY_ORDER_STATUS_SQL,
  getDisplayOrderStatus,
  getDisplayOrderStatusLabel,
};
