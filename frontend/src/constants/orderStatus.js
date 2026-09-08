export const ORDER_STATUS_BADGES = {
  payment_due: { text: '等待付款', class: 'badge-warning' },
  payment_received: { text: '官网已收款', class: 'badge-success' },
  processing: { text: '处理中', class: 'badge-info' },
  ready_for_pickup: { text: '可取货', class: 'badge-success' },
  picked_up: { text: '已取货', class: 'badge-success' },
  payment_expired: { text: '付款已过期', class: 'badge-error' },
  shipped: { text: '已发货', class: 'badge-info' },
  delivered: { text: '已送达', class: 'badge-success' },
  cancelled: { text: '已取消', class: 'badge-error' },
  pickup_cancelled: { text: '取货已取消', class: 'badge-error' },
  unknown: { text: '状态待核对', class: 'badge-warning' },
  pending: { text: '待处理（历史）', class: 'badge-warning' },
  completed: { text: '已完成（历史）', class: 'badge-success' },
};

export const ORDER_STATUS_LABELS = Object.fromEntries(
  Object.entries(ORDER_STATUS_BADGES).map(([key, badge]) => [key, badge.text])
);

export const PICKUP_STATUS_LABELS = {
  not_ready: '尚未准备就绪',
  ready_for_pickup: '可取货',
  picked_up: '已取货',
  not_applicable: '不适用',
  pickup_cancelled: '取货已取消',
  unknown: '待核对',
  not_picked_up: '未取货（历史）',
};

/** 格式化服务端已脱敏的冲突，空值不冒充 0。 */
export function formatOrderConflict(issue) {
  const detail =
    issue.sourceValue !== undefined && issue.officialValue !== undefined
      ? `（导入：${issue.sourceValue ?? '缺失'}；官网：${issue.officialValue ?? '缺失'}）`
      : '';
  return `${issue.message || '订单数据需要核对'}${detail}`;
}
