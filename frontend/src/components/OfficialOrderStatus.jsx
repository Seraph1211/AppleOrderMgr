import { formatOrderTime } from '../utils/orderTime';

const LABELS = {
  ORDER_PLACED: '订单已提交',
  ORDER_RECEIVED: '订单已收到',
  PROCESSING: '处理中',
  PAYMENT_PENDING: '待付款',
  PAYMENT_EXPIRED_STORED_ORDER: '付款已过期',
  READY_FOR_PICKUP: '可取货',
  PICKUP_READY: '可取货',
  PICKED_UP: '已取货',
  PREPARING_TO_SHIP: '准备发货',
  SHIPPED: '已发货',
  DELIVERED: '已送达',
  CANCELLED: '已取消',
  CANCELED: '已取消',
  PICKUP_CANCELLED: '取货已取消',
  PICK_UP_CANCELLED: '取货已取消',
};

export default function OfficialOrderStatus({ status, observedAt }) {
  return (
    <div className="max-w-xs space-y-1 text-sm" title={status || '尚无官网观测'}>
      {status ? (
        status.split(' | ').map(value => (
          <span key={value} className="badge badge-info mr-1 break-all whitespace-normal">
            {LABELS[value] || value}
          </span>
        ))
      ) : (
        <span className="text-gray-400">尚未更新</span>
      )}
      {observedAt && <p className="text-xs text-gray-500">{formatOrderTime(observedAt)}</p>}
    </div>
  );
}
