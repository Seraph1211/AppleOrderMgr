/**
 * 根据官网阶段展示付款终止原因，避免已过期订单继续等待截止时间。
 * @param {Object} task - 付款任务 DTO
 * @returns {string|null} 终态文案，仍需付款则返回 null
 */
export function getPaymentStageLabel(task) {
  const status = task.officialOrderStatus;
  if (status === 'payment_expired') return '付款已过期';
  if (task.officialPaymentStatus === 'refunded') return '已退款';
  if (['cancelled', 'pickup_cancelled'].includes(status)) return '订单已取消';
  if (task.officialPaymentStatus === 'paid' ||
    ['payment_received', 'processing', 'ready_for_pickup', 'picked_up', 'completed'].includes(status)) return '已付款';
  if (['shipped', 'delivered'].includes(status)) return '无需付款';
  return null;
}
