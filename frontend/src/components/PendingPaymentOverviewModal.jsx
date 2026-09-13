import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { getPendingPaymentOverview } from '../api/paymentDispatchApi';

/** 展示全部待付款订单的未分配和逐账号数量。 */
export default function PendingPaymentOverviewModal({ onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const dialogRef = useRef(null);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    setData(null);
    try {
      const response = await getPendingPaymentOverview();
      if (request === requestRef.current) setData(response.data);
    } catch (loadError) {
      if (request === requestRef.current) setError(loadError.message || '概览加载失败');
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    load();
    return () => {
      requestRef.current += 1;
      previous?.focus();
    };
  }, [load]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3 sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pending-overview-title"
        tabIndex={-1}
        className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90dvh] flex flex-col overflow-hidden outline-none"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Tab') {
            const buttons = [...dialogRef.current.querySelectorAll('button:not(:disabled)')];
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            if (event.shiftKey && [first, dialogRef.current].includes(document.activeElement)) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between gap-3 shrink-0">
          <h2 id="pending-overview-title" className="text-lg font-semibold text-gray-900">
            全局待付款概览
          </h2>
          <button
            className="btn btn-secondary p-2"
            aria-label="关闭全局待付款概览"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto min-h-0" aria-busy={loading}>
          <p className="text-sm text-gray-500 mb-4">
            统计全部等待付款的订单，不受当前筛选和分页影响。已付款、付款已过期及其他状态不计入。
          </p>
          {loading && (
            <p role="status" className="py-8 text-center text-gray-500">
              正在加载概览…
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 text-red-700 p-3">
              {error}
            </p>
          )}
          {data && (
            <>
              <div className="bg-primary-50 rounded-lg px-4 py-3 text-primary mb-4">
                <p className="font-semibold">待付款总数：{data.total} 单</p>
                <p className="text-sm mt-1">
                  未分配：{data.unassignedCount} 单 · 已分配：{data.assignedCount} 单
                </p>
              </div>
              {data.total === 0 && <p className="text-sm text-gray-500 mb-3">当前暂无待付款订单</p>}
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-3 py-2">负责人</th>
                    <th className="px-3 py-2 text-right">待付款订单数</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr className="hover:bg-gray-50">
                    <td className="px-3 py-3 font-medium">未分配</td>
                    <td className="px-3 py-3 text-right font-semibold text-primary">
                      {data.unassignedCount}
                    </td>
                  </tr>
                  {data.staff.map(person => (
                    <tr key={person.userId} className="hover:bg-gray-50">
                      <td className="px-3 py-3 break-all">
                        <div className="text-gray-900">{person.nickname}</div>
                        <div className="text-xs text-gray-500">
                          {person.username} · U{String(person.userId).padStart(4, '0')}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{person.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-500 mt-4">
                统计时间：{new Date(data.generatedAt).toLocaleString('zh-CN')}
              </p>
            </>
          )}
        </div>
        <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2 shrink-0">
          <button
            className="btn btn-secondary inline-flex items-center gap-2"
            disabled={loading}
            onClick={load}
          >
            <RefreshCw className="w-4 h-4" />
            {error ? '重试' : '更新统计'}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
