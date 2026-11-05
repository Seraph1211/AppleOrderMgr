import { useCallback, useEffect, useRef, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import {
  applePurchaseInventoryApi as api,
  subscribeApplePurchaseInventory,
} from '../api/applePurchaseInventoryApi';
import './applePurchaseInventory.css';

const TYPES = [
  ['baseline_created', '建立基线'],
  ['configuration_updated', '配置更新'],
  ['monitor_started', '启动监控'],
  ['monitor_stopped', '停止监控'],
  ['task_demand_updated', '任务需求更新'],
];
const typeText = Object.fromEntries(TYPES);
const beijingTime = value =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
const utc = value => (value ? new Date(`${value}:00+08:00`).toISOString() : undefined);

export default function ApplePurchaseMonitorChanges() {
  const [draft, setDraft] = useState({ from: '', to: '', monitorId: '', changeType: '' });
  const [filters, setFilters] = useState({});
  const [cursor, setCursor] = useState(null);
  const [cursorStack, setCursorStack] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const load = useCallback(
    async (quiet = false) => {
      const current = ++sequence.current;
      if (!quiet) setLoading(true);
      try {
        const result = await api.monitorChanges({
          ...filters,
          limit: 100,
          direction: 'desc',
          cursor: cursor || undefined,
        });
        if (current === sequence.current) {
          setData(result);
          setError('');
        }
      } catch (failure) {
        if (current === sequence.current) setError(failure.message);
      } finally {
        if (current === sequence.current) setLoading(false);
      }
    },
    [cursor, filters]
  );
  useEffect(() => {
    load();
  }, [load]);
  useEffect(
    () =>
      subscribeApplePurchaseInventory(version => {
        if (version.monitorChanges !== data?.page?.highWaterSequence) load(true);
      }),
    [data?.page?.highWaterSequence, load]
  );
  const apply = event => {
    event.preventDefault();
    setFilters({
      from: utc(draft.from),
      to: utc(draft.to),
      monitorId: draft.monitorId.trim() || undefined,
      changeType: draft.changeType || undefined,
    });
    setCursor(null);
    setCursorStack([]);
  };
  const next = () => {
    if (!data?.page?.nextCursor) return;
    setCursorStack(previous => [...previous, cursor]);
    setCursor(data.page.nextCursor);
  };
  const previous = () => {
    setCursorStack(stack => {
      if (!stack.length) return stack;
      setCursor(stack.at(-1));
      return stack.slice(0, -1);
    });
  };
  return (
    <div className="apple-purchase-page">
      <div className="apple-purchase-header">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">ApplePurchase 监控任务变更历史</h1>
          <p className="mt-1 text-sm text-gray-500">
            独立展示监控配置、启停和任务需求变化，不与有货记录混排。
          </p>
        </div>
        <button className="btn btn-secondary" onClick={() => load()} disabled={loading}>
          <RefreshCw className={`mr-1 inline h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>
      <form className="card" onSubmit={apply}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <input
            className="input"
            type="datetime-local"
            value={draft.from}
            onChange={event => setDraft({ ...draft, from: event.target.value })}
            aria-label="变更开始时间"
          />
          <input
            className="input"
            type="datetime-local"
            value={draft.to}
            onChange={event => setDraft({ ...draft, to: event.target.value })}
            aria-label="变更结束时间"
          />
          <input
            className="input"
            value={draft.monitorId}
            onChange={event => setDraft({ ...draft, monitorId: event.target.value })}
            placeholder="监控 ID（精确）"
          />
          <select
            className="input"
            value={draft.changeType}
            onChange={event => setDraft({ ...draft, changeType: event.target.value })}
          >
            <option value="">全部变更类型</option>
            {TYPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-3 flex justify-end">
          <button className="btn btn-primary" type="submit">
            应用筛选
          </button>
        </div>
      </form>
      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      <div className="apple-purchase-table-wrap">
        {loading ? (
          <p className="py-12 text-center text-gray-500" role="status">
            正在加载监控变更…
          </p>
        ) : data?.items?.length ? (
          <table className="apple-purchase-table">
            <thead>
              <tr>
                <th>变更时间（北京时间）</th>
                <th>监控</th>
                <th>类型</th>
                <th>修订</th>
                <th>来源</th>
                <th>变更前</th>
                <th>变更后</th>
                <th>序号</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(item => (
                <tr key={`${item.terminalId}:${item.eventId}`}>
                  <td>{beijingTime(item.changedAt)}</td>
                  <td>
                    <div className="font-medium text-gray-900">{item.monitorName}</div>
                    <div className="font-mono text-xs text-gray-500">{item.monitorId}</div>
                  </td>
                  <td>
                    <span className="badge badge-info">
                      {typeText[item.changeType] || item.changeType}
                    </span>
                  </td>
                  <td>
                    {item.previousRevision ?? '—'} → {item.revision ?? '—'}
                  </td>
                  <td>{item.source}</td>
                  <td>
                    <pre className="apple-purchase-json">
                      {JSON.stringify(item.before, null, 2)}
                    </pre>
                  </td>
                  <td>
                    <pre className="apple-purchase-json">{JSON.stringify(item.after, null, 2)}</pre>
                  </td>
                  <td className="font-mono text-xs">{item.sequence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="py-12 text-center text-gray-500">
            <History className="mx-auto mb-2 h-10 w-10 text-gray-300" />
            <p>当前筛选下没有监控变更</p>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">
          固定高水位：{data?.page?.highWaterSequence || '0'}
        </span>
        <div className="flex gap-2">
          <button className="btn btn-secondary" disabled={!cursorStack.length} onClick={previous}>
            上一页
          </button>
          <button className="btn btn-secondary" disabled={!data?.page?.hasMore} onClick={next}>
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
