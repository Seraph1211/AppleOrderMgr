import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { readIngestion } from '../api/orderIngestionApi';
import { useAuth } from '../contexts/AuthContext';
import { PERMISSIONS } from '../constants/permissions';

/** 订单来源追溯，仅在具备来源读取权限时请求。 */
export default function OrderSources({ orderId }) {
  const { can } = useAuth();
  const allowed = can(PERMISSIONS.INGESTION_READ);
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (!allowed) return undefined;
    setError('');
    readIngestion(`/orders/${orderId}/sources`, { page, limit: 10 })
      .then(response => {
        if (active) setData(response.data);
      })
      .catch(reason => {
        if (active) setError(reason.message || '来源记录读取失败');
      });
    return () => {
      active = false;
    };
  }, [allowed, orderId, page]);
  if (!allowed) return null;
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="mb-3 font-semibold text-gray-900">来源记录</h3>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {!data && !error && <p className="text-sm text-gray-500">正在读取来源…</p>}
      {data && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-gray-500">
                <tr>
                  <th className="p-2">来源</th>
                  <th className="p-2">接收时间</th>
                  <th className="p-2">结果</th>
                  <th className="p-2">追溯</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(row => (
                  <tr className="border-t border-gray-100" key={row.id}>
                    <td className="p-2">{row.source === 'aos' ? 'AOS 文件' : '邮件'}</td>
                    <td className="p-2">
                      {new Date(row.receivedAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                      })}
                    </td>
                    <td className="p-2">{row.result === 'created' ? '创建订单' : '重复留痕'}</td>
                    <td className="p-2">
                      {row.aosRecordId ? (
                        <Link
                          className="text-primary hover:underline"
                          to={`/order-ingestion?record=${row.aosRecordId}`}
                        >
                          查看接收记录
                        </Link>
                      ) : (
                        `邮件记录 #${row.emailLogId}`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.total === 0 && (
            <p className="py-3 text-sm text-gray-500">没有可确认的历史来源记录</p>
          )}
          <div className="mt-3 flex items-center justify-between text-sm text-gray-500">
            <span>共 {data.total} 条</span>
            <div className="flex gap-2">
              <button
                className="btn btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </button>
              <button
                className="btn btn-secondary"
                disabled={page * 10 >= data.total}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
