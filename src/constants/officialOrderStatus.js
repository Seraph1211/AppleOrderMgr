/** 官网状态展示名，筛选与列表共用；未知值保留原文。 */
const OFFICIAL_ORDER_STATUS_LABELS = {
  // eslint-disable-next-line camelcase -- 沿用官网状态筛选协议键
  __not_observed__: '尚未更新',
  ORDER_PLACED: '订单已提交',
  ORDER_RECEIVED: '订单已收到',
  PROCESSING: '处理中',
  PAYMENT_PENDING: '待付款',
  PAYMENT_EXPIRED_STORED_ORDER: '付款已过期',
  READY_FOR_PICKUP: '可取货',
  PICKUP_READY: '可取货',
  PICKED_UP: '已取货',
  RETURN_STARTED: '已发起退货',
  PREPARING_TO_SHIP: '准备发货',
  SHIPPED: '已发货',
  DELIVERED: '已送达',
  CANCELLED: '已取消',
  CANCELED: '已取消',
  PICKUP_CANCELLED: '取货已取消',
  PICK_UP_CANCELLED: '取货已取消',
};

module.exports = { OFFICIAL_ORDER_STATUS_LABELS };
