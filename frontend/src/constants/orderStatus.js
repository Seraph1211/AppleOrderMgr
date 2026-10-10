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
  unknown: { text: 'unknown', class: 'badge-warning' },
  pending: { text: '待处理', class: 'badge-warning' },
};

/** 获取官网状态展示；无效存量值统一展示 unknown。 */
export function getOrderStatusBadge(status) {
  return Object.hasOwn(ORDER_STATUS_BADGES, status)
    ? ORDER_STATUS_BADGES[status]
    : ORDER_STATUS_BADGES.unknown;
}

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

export const EMAIL_ORDER_STATUS_BADGES = {
  unknown: {
    text: '待确认',
    class: 'bg-gray-100 text-gray-700 border border-gray-200',
  },
  confirmed: { text: '订单已确认', class: 'badge-info' },
  processing: {
    text: '处理中',
    class: 'bg-purple-100 text-purple-700 border border-purple-200',
  },
  ready_for_pickup: { text: '可取货', class: 'badge-success' },
  picked_up: {
    text: '已取货',
    class: 'bg-blue-100 text-blue-800 border border-blue-200',
  },
  partially_cancelled: { text: '部分取消', class: 'badge-warning' },
  partially_return_requested: { text: '部分发起退货', class: 'badge-warning' },
  return_requested: { text: '已发起退货', class: 'badge-warning' },
  expired: { text: '已过期', class: 'badge-error' },
  cancelled: { text: '已取消', class: 'badge-error' },
};

export const DISPLAY_ORDER_STATUS_BADGES = {
  unknown: EMAIL_ORDER_STATUS_BADGES.unknown,
  confirmed: EMAIL_ORDER_STATUS_BADGES.confirmed,
  payment_timeout: { text: '付款超时', class: 'badge-warning' },
  processing: EMAIL_ORDER_STATUS_BADGES.processing,
  ready_for_pickup: EMAIL_ORDER_STATUS_BADGES.ready_for_pickup,
  picked_up: EMAIL_ORDER_STATUS_BADGES.picked_up,
  partially_cancelled: EMAIL_ORDER_STATUS_BADGES.partially_cancelled,
  partially_return_requested: EMAIL_ORDER_STATUS_BADGES.partially_return_requested,
  return_requested: EMAIL_ORDER_STATUS_BADGES.return_requested,
  expired: EMAIL_ORDER_STATUS_BADGES.expired,
  cancelled: EMAIL_ORDER_STATUS_BADGES.cancelled,
};

export const DISPLAY_ORDER_STATUS_LABELS = Object.fromEntries(
  Object.entries(DISPLAY_ORDER_STATUS_BADGES).map(([key, badge]) => [key, badge.text])
);

export const EMAIL_ORDER_STATUS_LABELS = Object.fromEntries(
  Object.entries(EMAIL_ORDER_STATUS_BADGES).map(([key, badge]) => [key, badge.text])
);

/** 获取邮件订单状态标签；未知存量值按待确认展示。 */
export function getEmailOrderStatusBadge(status) {
  return Object.hasOwn(EMAIL_ORDER_STATUS_BADGES, status)
    ? EMAIL_ORDER_STATUS_BADGES[status]
    : EMAIL_ORDER_STATUS_BADGES.unknown;
}

/** 获取订单管理展示状态标签。 */
export function getDisplayOrderStatusBadge(status) {
  return Object.hasOwn(DISPLAY_ORDER_STATUS_BADGES, status)
    ? DISPLAY_ORDER_STATUS_BADGES[status]
    : DISPLAY_ORDER_STATUS_BADGES.unknown;
}
