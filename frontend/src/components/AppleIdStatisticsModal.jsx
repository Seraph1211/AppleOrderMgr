import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import client from '../api/client';
import { getAppleIdStatusBadge } from '../constants/appleIdStatus';

/** 全库 Apple ID 数量统计，与列表搜索、状态和分页无关。 */
export default function AppleIdStatisticsModal({ onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const closeRef = useRef(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const handleKey = event => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previousFocus?.focus();
    };
  }, [onClose]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await client.get('/apple-ids/statistics');
        if (!response.success) throw new Error('加载统计失败');
        if (active) setData(response.data);
      } catch (failure) {
        if (active) setError(failure.message || '加载统计失败，请重试');
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [version]);
  return (
    <div className="!m-0 fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Apple ID 统计分析"
        className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col"
      >
        <div className="p-5 border-b border-gray-200 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-gray-900">统计分析</h2>
          <button
            ref={closeRef}
            aria-label="关闭统计分析"
            className="p-2 rounded-lg hover:bg-gray-100"
            onClick={onClose}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-500">统计全部 Apple ID，不受列表筛选和分页影响。</p>
            <button
              className="btn btn-secondary flex items-center gap-2"
              disabled={loading}
              onClick={() => setVersion(previous => previous + 1)}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </button>
          </div>
          {loading ? (
            <p role="status" className="py-6 text-center text-gray-500">
              正在加载统计…
            </p>
          ) : error ? (
            <div className="space-y-3">
              <p role="alert" className="text-red-700">
                {error}
              </p>
              <button
                className="btn btn-secondary"
                onClick={() => setVersion(previous => previous + 1)}
              >
                重试
              </button>
            </div>
          ) : (
            data && (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-gray-500">
                      <tr>
                        <th className="p-3 text-left">状态</th>
                        <th className="p-3 text-right">数量</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-gray-200 font-semibold text-primary">
                        <th className="p-3 text-left">总数</th>
                        <td className="p-3 text-right">{data.total}</td>
                      </tr>
                      {data.statuses.map(row => {
                        const badge = getAppleIdStatusBadge(row.status);
                        return (
                          <tr key={row.status} className="border-b border-gray-200">
                            <td className="p-3">
                              <span className={`badge ${badge.class}`}>{badge.text}</span>
                            </td>
                            <td className="p-3 text-right text-gray-700">{row.count}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {data.total === 0 && (
                  <p className="text-center text-sm text-gray-500">
                    暂无 Apple ID，所有状态数量为 0。
                  </p>
                )}
              </>
            )
          )}
        </div>
        <div className="p-4 border-t border-gray-200 flex justify-end">
          <button className="btn btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
