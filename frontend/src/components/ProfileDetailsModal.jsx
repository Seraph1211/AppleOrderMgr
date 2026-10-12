import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Link } from 'react-router-dom';
import client from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { formatOrderTime } from '../utils/orderTime';
import { getDisplayOrderStatusBadge } from '../constants/orderStatus';

/** 展示独立档案及按订单自身外键关联、授权 TAG 范围内的订单。 */
export default function ProfileDetailsModal({ kind, item, onClose }) {
  const { can } = useAuth();
  const [orders, setOrders] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retryVersion, setRetryVersion] = useState(0);
  const [qa, setQa] = useState(undefined);
  const [qaLoading, setQaLoading] = useState(false);
  const [qaError, setQaError] = useState('');
  const qaRequest = useRef(0);
  const account = kind === 'account';
  const resource = account ? 'apple-ids' : 'recipients';
  const canOrders = can('orders.read');
  const canQa = account && can('apple_ids.secrets.read');

  useEffect(() => {
    setPage(1);
    setQa(undefined);
    setQaError('');
    setQaLoading(false);
    return () => {
      qaRequest.current += 1;
    };
  }, [item.id, resource, canQa]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setOrders([]);
    setTotal(0);
    setDetail(null);
    Promise.all([
      client.get(`/${resource}/${item.id}`),
      canOrders
        ? client.get('/orders', {
            params: { [account ? 'apple_id' : 'recipient_id']: item.id, page, limit: 20 },
          })
        : Promise.resolve(null),
    ])
      .then(([profile, orderResponse]) => {
        if (active) {
          setDetail(profile.data);
          setOrders(orderResponse?.data.orders || []);
          setTotal(orderResponse?.data.total || 0);
        }
      })
      .catch(failure => {
        if (active) setError(failure.message || '加载档案失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [item.id, resource, account, page, canOrders, retryVersion]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const handleKey = event => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previousFocus?.focus();
    };
  }, [onClose]);

  const loadQa = async () => {
    const requestId = ++qaRequest.current;
    setQaLoading(true);
    setQaError('');
    try {
      const response = await client.get(`/apple-ids/${item.id}`, {
        params: { includeSecrets: true },
      });
      if (requestId === qaRequest.current) setQa(response.data.security_qa || null);
    } catch (failure) {
      if (requestId === qaRequest.current) setQaError(failure.message || '加载密保失败');
    } finally {
      if (requestId === qaRequest.current) setQaLoading(false);
    }
  };
  const time = value => (value ? formatOrderTime(value) : '—');
  return (
    <div className="!m-0 fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="档案详情"
        className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col"
      >
        <div className="p-5 border-b flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold break-all">
            {account ? item.appleId : item.name} · 档案详情
          </h2>
          <button
            aria-label="关闭"
            className="p-2 hover:bg-gray-100 rounded-lg shrink-0"
            onClick={onClose}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto space-y-5">
          {error && (
            <div className="text-red-700 bg-red-50 p-3 rounded space-y-3">
              <p role="alert">{error}</p>
              <button
                className="btn btn-secondary"
                onClick={() => setRetryVersion(previous => previous + 1)}
              >
                重试
              </button>
            </div>
          )}
          {loading ? (
            <p role="status" className="text-gray-500">
              正在加载…
            </p>
          ) : (
            !error && (
              <>
                <p className="text-sm text-gray-700">使用状态：{detail?.status || '—'}</p>
                {!account && (
                  <p className="text-sm text-gray-700">
                    TAG：{detail?.tag || '—'} · 渠道：{detail?.channel || '—'}
                  </p>
                )}
                {canQa && (
                  <div className="space-y-2">
                    <button
                      className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={qaLoading}
                      onClick={loadQa}
                    >
                      {qaLoading ? '正在读取密保…' : '查看密保'}
                    </button>
                    {qaError && (
                      <p role="alert" className="text-red-700">
                        {qaError}
                      </p>
                    )}
                    {qa === null && <p>未设置密保</p>}
                    {qa && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[500px]">
                          <tbody>
                            {[1, 2, 3].map(i => (
                              <tr className="border-b" key={i}>
                                <th className="p-2 text-left">问题 {i}</th>
                                <td>{qa[`question${i}`]}</td>
                                <th className="p-2 text-left">答案</th>
                                <td>{qa[`answer${i}`]}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
                {canOrders && (
                  <div>
                    <h3 className="font-semibold mb-2">名下订单（{total}）</h3>
                    <p className="text-sm text-gray-500 mb-3">
                      按订单关联的{account ? 'Apple ID' : '取机人'}
                      展示，仅包含当前有权限查看的订单。
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm min-w-[640px]">
                        <thead className="bg-gray-50">
                          <tr>
                            {['订单号', 'Apple ID', '取机人', '状态', '时间', '操作'].map(label => (
                              <th key={label} className="text-left p-2 whitespace-nowrap">
                                {label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {orders.map(order => (
                            <tr key={order.id} className="border-b hover:bg-gray-50">
                              <td className="p-2">{order.order_number}</td>
                              <td className="p-2">{order.apple_id || '—'}</td>
                              <td className="p-2">{order.recipient_name || '—'}</td>
                              <td className="p-2">
                                {(() => {
                                  const badge = getDisplayOrderStatusBadge(
                                    order.display_order_status ||
                                      order.email_order_status ||
                                      'unknown'
                                  );
                                  return (
                                    <span className={`badge ${badge.class}`}>{badge.text}</span>
                                  );
                                })()}
                              </td>
                              <td className="p-2 whitespace-nowrap">
                                {time(order.order_date || order.created_at)}
                              </td>
                              <td className="p-2">
                                <Link
                                  className="text-primary underline"
                                  to={`/orders/${order.id}`}
                                  onClick={onClose}
                                >
                                  详情
                                </Link>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!orders.length && <p className="p-4 text-gray-500">暂无已关联订单</p>}
                    </div>
                    <div className="flex flex-wrap justify-end items-center gap-3 mt-3">
                      <button
                        className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={page <= 1}
                        onClick={() => setPage(previous => previous - 1)}
                      >
                        上一页
                      </button>
                      <span>
                        {page} / {Math.max(1, Math.ceil(total / 20))}
                      </span>
                      <button
                        className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={page * 20 >= total}
                        onClick={() => setPage(previous => previous + 1)}
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                )}
              </>
            )
          )}
        </div>
        <div className="p-4 border-t flex justify-end">
          <button className="btn btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
