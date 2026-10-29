import { formatOrderTime } from '../utils/orderTime';
import { Loader2 } from 'lucide-react';

import {
  OFFICIAL_ORDER_STATUS_COLORS,
  OFFICIAL_ORDER_STATUS_LABELS,
} from '../constants/officialOrderStatus';

/** 逐项显示官网原始观测状态，同义状态保持一致颜色。 */

export default function OfficialOrderStatus({ status, observedAt, loading = false }) {
  return (
    <div className="max-w-xs space-y-1 text-sm" title={status || '尚无官网观测'}>
      {loading && (
        <span className="flex items-center gap-1 text-primary" role="status">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          查询中
        </span>
      )}
      {status ? (
        status.split(' | ').map(value => (
          <span
            key={value}
            className={`badge mr-1 break-all whitespace-normal ${OFFICIAL_ORDER_STATUS_COLORS[value] || OFFICIAL_ORDER_STATUS_COLORS.__not_observed__}`}
          >
            {OFFICIAL_ORDER_STATUS_LABELS[value] || value}
          </span>
        ))
      ) : !loading ? (
        <span className="text-gray-400">尚未更新</span>
      ) : null}
      {observedAt && (
        <p className="order-timestamp text-xs text-gray-500">{formatOrderTime(observedAt)}</p>
      )}
    </div>
  );
}
