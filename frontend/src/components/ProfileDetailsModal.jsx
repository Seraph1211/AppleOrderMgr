import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Link } from 'react-router-dom';
import client from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { formatOrderTime } from '../utils/orderTime';

/** 按订单自己的档案外键展示订单，绑定历史仅供追溯。 */
export default function ProfileDetailsModal({ kind, item, onClose }) {
  const { can } = useAuth();
  const [orders, setOrders] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState([]);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [qa, setQa] = useState(undefined);
  const account = kind === 'account';
  const resource = account ? 'apple-ids' : 'recipients';
  const canHistory = can('apple_ids.read') && can('recipients.read');
  const canOrders = can('orders.read');
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([
      client.get(`/${resource}/${item.id}`),
      canOrders
        ? client.get('/orders', {
            params: { [account ? 'apple_id' : 'recipient_id']: item.id, page, limit: 20 },
          })
        : Promise.resolve(null),
      canHistory ? client.get(`/${resource}/${item.id}/bindings`) : Promise.resolve(null),
    ])
      .then(([profile, orderResponse, historyResponse]) => {
        if (active) {
          setDetail(profile.data);
          setOrders(orderResponse?.data.orders || []);
          setTotal(orderResponse?.data.total || 0);
          setHistory(historyResponse?.data || []);
        }
      })
      .catch(failure => {
        if (active) setError(failure.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [item.id, resource, account, page, canOrders, canHistory]);
  const loadQa = async () => {
    try {
      const response = await client.get(`/apple-ids/${item.id}`, {
        params: { includeSecrets: true },
      });
      setQa(response.data.security_qa || null);
    } catch (failure) {
      setError(failure.message);
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
        <div className="p-5 border-b flex justify-between">
          <h2 className="text-xl font-semibold">{account ? item.appleId : item.name} · 档案详情</h2>
          <button aria-label="关闭" onClick={onClose}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-auto space-y-5">
          {error && (
            <p role="alert" className="text-red-700 bg-red-50 p-3">
              {error}
            </p>
          )}
          {loading ? (
            <p>正在加载…</p>
          ) : (
            <>
              <p className="text-sm text-gray-700">
                当前关联：
                {account
                  ? canHistory
                    ? detail?.recipients?.map(r => r.name).join('、') || '未绑定'
                    : '无取机人查看权限'
                  : detail?.apple_id || '未绑定'}{' '}
                · 使用状态：{detail?.status}
              </p>
              {account && can('apple_ids.secrets.read') && (
                <div className="space-y-2">
                  <button
                    className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={loadQa}
                  >
                    查看密保
                  </button>
                  {qa === null && <p>未设置密保</p>}
                  {qa && (
                    <table className="w-full text-sm">
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
                  )}
                </div>
              )}
              {canOrders && (
                <div>
                  <h3 className="font-semibold mb-2">名下订单（{total}）</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          {['订单号', 'Apple ID', '取机人', '状态', '时间', '操作'].map(x => (
                            <th key={x} className="text-left p-2">
                              {x}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {orders.map(order => (
                          <tr key={order.id} className="border-b">
                            <td className="p-2">{order.order_number}</td>
                            <td>{order.apple_id || '—'}</td>
                            <td>{order.recipient_name || '—'}</td>
                            <td>{order.status}</td>
                            <td>{time(order.order_date || order.created_at)}</td>
                            <td>
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
                  <div className="flex justify-end items-center gap-3 mt-3">
                    <button
                      className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={page <= 1}
                      onClick={() => setPage(page - 1)}
                    >
                      上一页
                    </button>
                    <span>
                      {page} / {Math.max(1, Math.ceil(total / 20))}
                    </span>
                    <button
                      className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={page * 20 >= total}
                      onClick={() => setPage(page + 1)}
                    >
                      下一页
                    </button>
                  </div>
                </div>
              )}
              {canHistory && (
                <div>
                  <h3 className="font-semibold mb-2">绑定历史（最近 200 条）</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          {['取机人', 'Apple ID', '开始时间', '结束时间'].map(x => (
                            <th key={x} className="p-2 text-left">
                              {x}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {history.map(row => (
                          <tr key={row.id} className="border-b">
                            <td className="p-2">{row.recipient_name}</td>
                            <td>{row.apple_id}</td>
                            <td>
                              {row.started_at
                                ? time(row.started_at)
                                : `导入前已绑定（${time(row.observed_at)} 记录）`}
                            </td>
                            <td>{row.ended_at ? time(row.ended_at) : '当前绑定'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!history.length && <p className="p-4 text-gray-500">暂无绑定记录</p>}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="p-4 border-t flex justify-end">
          <button
            className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
