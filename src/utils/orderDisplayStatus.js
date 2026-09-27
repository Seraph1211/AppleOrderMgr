const { getPaymentDeadline } = require('../services/paymentEligibility');

const DISPLAY_ORDER_STATUSES = Object.freeze([
  'unknown',
  'confirmed',
  'expired',
  'processing',
  'ready_for_pickup',
  'picked_up',
]);

// 列表筛选与展示使用同一来源时间和邮件付款证据；不改写邮件生命周期。
const DISPLAY_ORDER_STATUS_SQL = `CASE WHEN "Order"."email_order_status" = 'confirmed'
  AND "Order"."email_payment_status" <> 'paid'
  AND "Order"."order_date" IS NOT NULL
  AND "Order"."order_date" + INTERVAL '30 minutes' <= CURRENT_TIMESTAMP
  THEN 'expired' ELSE "Order"."email_order_status" END`;

/** 从邮件阶段、付款证据和来源下单时间派生订单管理展示状态。 */
function getDisplayOrderStatus(order, now = new Date()) {
  const status = order?.emailOrderStatus || 'unknown';
  if (status !== 'confirmed' || order?.emailPaymentStatus === 'paid') return status;
  const deadline = getPaymentDeadline(order);
  return deadline && deadline <= now ? 'expired' : status;
}

module.exports = {
  DISPLAY_ORDER_STATUSES,
  DISPLAY_ORDER_STATUS_SQL,
  getDisplayOrderStatus,
};
