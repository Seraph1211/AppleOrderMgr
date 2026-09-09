import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import client from '../api/client';

const EMPTY_FILTERS = { keyword: '', action: '', result: '', dateFrom: '', dateTo: '' };

/** 管理员账号操作记录，使用中文身份、动作及结果。 */
export default function OperationLogs() {
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [query, setQuery] = useState({ ...EMPTY_FILTERS, page: 1 });
  const [data, setData] = useState({ logs: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(() => {
    const current = ++sequence.current;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const params = { ...query, limit: 20 };
        for (const key of ['dateFrom', 'dateTo'])
          if (params[key]) params[key] = new Date(params[key]).toISOString();
        const response = await client.get('/system/operation-logs', { params });
        if (sequence.current === current) setData(response.data);
      } catch (failure) {
        if (sequence.current === current) setError(failure.message);
      } finally {
        if (sequence.current === current) setLoading(false);
      }
    };
    load();
    return () => {
      sequence.current = current + 1;
    };
  }, [query]);
  const field = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">操作记录</h1>
          <p className="text-sm text-gray-500 mt-1">
            查看谁在什么时间、从哪个 IP 执行了什么操作。昵称保留操作时的记录。
          </p>
        </div>
        <button
          className="btn btn-secondary flex items-center gap-2"
          disabled={loading}
          onClick={() => setQuery({ ...query })}
        >
          <RefreshCw className="w-4 h-4" />
          刷新
        </button>
      </div>
      <form
        className="card space-y-4"
        onSubmit={event => {
          event.preventDefault();
          setQuery({ ...draft, page: 1 });
        }}
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="text-sm text-gray-700">
            账号／昵称
            <input
              className="input mt-1"
              placeholder="账号 ID、登录账号或昵称"
              value={draft.keyword}
              onChange={event => field('keyword', event.target.value)}
            />
          </label>
          <label className="text-sm text-gray-700">
            操作内容
            <input
              className="input mt-1"
              placeholder="例如：重置密码、订单"
              value={draft.action}
              onChange={event => field('action', event.target.value)}
            />
          </label>
          <label className="text-sm text-gray-700">
            结果
            <select
              className="input mt-1"
              value={draft.result}
              onChange={event => field('result', event.target.value)}
            >
              <option value="">全部结果</option>
              <option value="success">成功</option>
              <option value="failed">失败／被拒绝</option>
              <option value="cancelled">等待确认登录</option>
            </select>
          </label>
          <label className="text-sm text-gray-700">
            开始时间
            <input
              type="datetime-local"
              className="input mt-1"
              value={draft.dateFrom}
              onChange={event => field('dateFrom', event.target.value)}
            />
          </label>
          <label className="text-sm text-gray-700">
            结束时间
            <input
              type="datetime-local"
              className="input mt-1"
              value={draft.dateTo}
              onChange={event => field('dateTo', event.target.value)}
            />
          </label>
        </div>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setQuery({ ...EMPTY_FILTERS, page: 1 });
            }}
          >
            清空筛选
          </button>
          <button className="btn btn-primary">查询</button>
        </div>
      </form>
      <div className="card">
        {loading ? (
          <p role="status" className="py-12 text-center text-gray-500">
            加载操作记录...
          </p>
        ) : error ? (
          <p role="alert" className="py-8 text-center text-red-600">
            {error}
          </p>
        ) : !data.logs.length ? (
          <p className="py-12 text-center text-gray-500">暂无符合条件的操作记录</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  {['时间', '账号 ID', '操作人', '执行动作', '操作对象', 'IP 地址', '结果'].map(
                    label => (
                      <th key={label} className="text-left px-4 py-3 whitespace-nowrap">
                        {label}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {data.logs.map(log => (
                  <tr key={log.id} className="border-b border-gray-200 hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                    <td className="px-4 py-3">{log.accountId || '未登录'}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">
                        {log.nickname || log.username || '未识别账号'}
                      </p>
                      <p className="text-gray-500">{log.username}</p>
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">{log.action}</td>
                    <td className="px-4 py-3 text-gray-600 max-w-sm break-words">{log.target}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{log.ip || '未获取'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`badge whitespace-nowrap ${log.result === 'success' ? 'badge-success' : 'badge-warning'}`}
                      >
                        {log.resultLabel}
                      </span>
                      <p className="text-xs text-gray-500 mt-1">状态码 {log.statusCode}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between text-sm text-gray-600">
        <p>
          共 {data.total} 条 · 第 {query.page} 页
        </p>
        <div className="flex gap-3">
          <button
            className="btn btn-secondary"
            disabled={loading || query.page <= 1}
            onClick={() => setQuery({ ...query, page: query.page - 1 })}
          >
            上一页
          </button>
          <button
            className="btn btn-secondary"
            disabled={loading || query.page * 20 >= data.total}
            onClick={() => setQuery({ ...query, page: query.page + 1 })}
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
