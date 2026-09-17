import { getOrderStatusBadge } from '../constants/orderStatus';

/** 付款页面沿用订单管理的官网状态语义颜色。 */
export function getOfficialStatusTagClass(orderStatus) {
  return `badge ${getOrderStatusBadge(orderStatus).class}`;
}
