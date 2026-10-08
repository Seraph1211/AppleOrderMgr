import { formatOrderTime } from '../utils/orderTime';

import { OFFICIAL_ORDER_STATUS_LABELS } from '../constants/officialOrderStatus';

const STATUS_COLORS = {
  ORDER_PLACED: 'bg-slate-100 text-slate-700',
  ORDER_RECEIVED: 'bg-indigo-100 text-indigo-800',
  PROCESSING: 'bg-blue-100 text-blue-800',
  PAYMENT_PENDING: 'bg-amber-100 text-amber-800',
  PAYMENT_EXPIRED_STORED_ORDER: 'bg-stone-200 text-stone-700',
  READY_FOR_PICKUP: 'bg-teal-100 text-teal-800',
  PICKUP_READY: 'bg-teal-100 text-teal-800',
  PICKED_UP: 'bg-green-100 text-green-800',
  PREPARING_TO_SHIP: 'bg-violet-100 text-violet-800',
  SHIPPED: 'bg-cyan-100 text-cyan-800',
  DELIVERED: 'bg-emerald-100 text-emerald-800',
  CANCELLED: 'bg-red-100 text-red-800',
  CANCELED: 'bg-red-100 text-red-800',
  PICKUP_CANCELLED: 'bg-rose-100 text-rose-800',
  PICK_UP_CANCELLED: 'bg-rose-100 text-rose-800',
};

/** 逐项显示官网原始观测状态，同义状态保持一致颜色。 */

export default function OfficialOrderStatus({ status, observedAt }) {
  return (
    <div className="max-w-xs space-y-1 text-sm" title={status || '尚无官网观测'}>
      {status ? (
        status.split(' | ').map(value => (
          <span
            key={value}
            className={`badge mr-1 break-all whitespace-normal ${STATUS_COLORS[value] || 'bg-gray-100 text-gray-700'}`}
          >
            {OFFICIAL_ORDER_STATUS_LABELS[value] || value}
          </span>
        ))
      ) : (
        <span className="text-gray-400">尚未更新</span>
      )}
      {observedAt && <p className="text-xs text-gray-500">{formatOrderTime(observedAt)}</p>}
    </div>
  );
}
