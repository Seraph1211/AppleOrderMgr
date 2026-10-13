import RecipientTag from './RecipientTag';
import { Copy, Pencil, RefreshCw } from 'lucide-react';
import OfficialOrderStatus from './OfficialOrderStatus';
import ProductSummary from './ProductSummary';
import OrderAmount from './OrderAmount';
import PaymentCodeButton from './PaymentCodeButton';
import AlipayPaymentLinkButton from './AlipayPaymentLinkButton';
import { formatOrderTime } from '../utils/orderTime';
import { formatPaymentCountdown } from '../utils/paymentCountdown';
import { isAlipayPayment } from '../utils/paymentMethod';

const COLUMNS = [
  '订单',
  '商品信息',
  '官网订单状态',
  '取机人TAG',
  '下单时间',
  '付款倒计时',
  '处理人',
  '处理备注',
  '操作',
];

/** 两个付款页面共用订单列、官网状态与受权限控制的行操作。 */
export default function PaymentOrdersTable({
  tasks,
  loading,
  now,
  selectedKeys,
  selectedIds,
  onSelect,
  canSelect,
  canCopy,
  canEdit,
  canRefresh,
  copyingIds = [],
  onCopy,
  onEdit,
  getAlipayLink,
  onResult,
  dispatch = false,
  refresh,
}) {
  return (
    <div>
      <p className="px-4 py-2 text-xs text-gray-500">窄屏可左右滑动表格，操作位于最右侧</p>
      <div className="overflow-x-auto" data-payment-orders-table>
        <table className="w-full min-w-[1680px]">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {canSelect && (
                <th className="px-4 py-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer accent-primary"
                    aria-label="选择当前页全部任务"
                    disabled={loading || copyingIds.length > 0}
                    checked={tasks.length > 0 && selectedIds.length === tasks.length}
                    ref={element => {
                      if (element)
                        element.indeterminate =
                          selectedIds.length > 0 && selectedIds.length < tasks.length;
                    }}
                    onChange={event =>
                      onSelect(event.target.checked ? tasks.map(task => task.id) : [])
                    }
                  />
                </th>
              )}
              {COLUMNS.map(title => (
                <th
                  key={title}
                  data-column={title}
                  className="px-4 py-3 text-sm font-medium text-gray-500 whitespace-nowrap text-left"
                >
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={COLUMNS.length + (canSelect ? 1 : 0)}
                  className="py-12 text-center text-gray-500"
                >
                  加载中...
                </td>
              </tr>
            ) : tasks.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMNS.length + (canSelect ? 1 : 0)}
                  className="py-12 text-center text-gray-500"
                >
                  暂无匹配的付款任务
                </td>
              </tr>
            ) : (
              tasks.map(task => {
                const countdown = formatPaymentCountdown(task, now, '时间未知');
                const action = refresh.actions[task.id];
                const querying =
                  action?.busy || ['queued', 'running'].includes(task.officialRefreshState);
                return (
                  <tr key={task.id} className="border-b border-gray-100 align-top hover:bg-gray-50">
                    {canSelect && (
                      <td className="px-4 py-4">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-primary"
                          aria-label={`选择订单 ${task.orderNumber}`}
                          disabled={copyingIds.length > 0}
                          checked={selectedIds.includes(task.id)}
                          onChange={() =>
                            onSelect(
                              selectedIds.includes(task.id)
                                ? selectedIds.filter(id => id !== task.id)
                                : [...selectedIds, task.id]
                            )
                          }
                        />
                      </td>
                    )}
                    <td data-label="订单" className="px-4 py-4">
                      <div className="mb-1 text-sm font-semibold text-gray-900">
                        订单 ID：{task.orderId ?? '-'}
                      </div>
                      <div className="font-mono text-sm text-primary">
                        {task.orderNumber || '-'}
                      </div>
                    </td>
                    <td data-label="商品信息" className="px-4 py-4 text-sm text-gray-700">
                      <div className="w-64 break-words">
                        <ProductSummary products={task.products} selectedKeys={selectedKeys} />
                        <OrderAmount amount={task.orderAmount} compact />
                      </div>
                    </td>
                    <td data-label="官网订单状态" className="px-4 py-4">
                      <OfficialOrderStatus
                        status={task.officialRawStatus}
                        observedAt={task.officialStatusObservedAt}
                        loading={querying}
                      />
                      {action?.message && (!action.pending || querying) && (
                        <p
                          role="status"
                          className={`mt-2 max-w-60 text-xs ${action.error ? 'text-red-600' : 'text-gray-500'}`}
                        >
                          {action.message}
                        </p>
                      )}
                    </td>
                    <td data-label="取机人TAG" className="px-4 py-4 text-sm">
                      <RecipientTag value={task.recipientTag} state={task.recipientTagState} />
                    </td>
                    <td data-label="下单时间" className="px-4 py-4 text-sm text-gray-600">
                      {formatOrderTime(task.orderDate)}
                    </td>
                    <td
                      data-label="付款倒计时"
                      className={`px-4 py-4 text-sm ${countdown.className}`}
                    >
                      {countdown.text}
                    </td>
                    <td data-label="处理人" className="px-4 py-4 text-sm text-gray-700">
                      {task.assignee?.nickname || task.assignee?.username || '未分配'}
                    </td>
                    <td data-label="处理备注" className="px-4 py-4">
                      <p className="w-48 whitespace-pre-wrap break-words text-sm text-gray-700">
                        {task.processingNotes || '-'}
                      </p>
                    </td>
                    <td data-label="操作" className="px-4 py-4">
                      <div className="payment-order-actions grid grid-cols-2 items-stretch gap-2">
                        {canCopy &&
                          (isAlipayPayment(task.paymentMethod) ? (
                            <AlipayPaymentLinkButton
                              task={task}
                              getLink={getAlipayLink}
                              onResult={onResult}
                            />
                          ) : (
                            <PaymentCodeButton
                              taskId={task.id}
                              orderDate={task.orderDate}
                              dispatch={dispatch}
                            />
                          ))}
                        {canCopy && (
                          <button
                            className="btn btn-secondary inline-flex items-center justify-center gap-2 whitespace-nowrap"
                            disabled={copyingIds.length > 0}
                            onClick={() => onCopy(task)}
                            aria-label={`复制订单信息 ${task.orderNumber}`}
                          >
                            <Copy className="w-4 h-4" />
                            {copyingIds.includes(task.id) ? '复制中...' : '复制订单信息'}
                          </button>
                        )}
                        {canRefresh && (
                          <button
                            className="btn btn-secondary inline-flex items-center justify-center gap-2 whitespace-nowrap"
                            disabled={querying}
                            onClick={() => refresh.start(task)}
                            aria-label={`更新订单状态 ${task.orderNumber}`}
                          >
                            <RefreshCw
                              className={`w-4 h-4 ${querying ? 'animate-spin motion-reduce:animate-none' : ''}`}
                            />
                            {querying ? '查询中...' : '更新订单状态'}
                          </button>
                        )}
                        {canEdit && (
                          <button
                            className="btn btn-secondary inline-flex items-center justify-center gap-2 whitespace-nowrap"
                            onClick={() => onEdit(task)}
                            aria-label={`编辑备注 订单 ${task.orderId}`}
                          >
                            <Pencil className="w-4 h-4" />
                            编辑备注
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
