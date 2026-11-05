import { useCallback, useEffect, useRef, useState } from 'react';
import { PackageCheck, RefreshCw, Radio, RadioTower } from 'lucide-react';
import {
  applePurchaseInventoryApi as api,
  subscribeApplePurchaseInventory,
} from '../api/applePurchaseInventoryApi';
import './applePurchaseInventory.css';

const beijingTime = value =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : '—';

const utc = value => (value ? new Date(`${value}:00+08:00`).toISOString() : undefined);

export default function ApplePurchaseInventory() {
  const [draft, setDraft] = useState({ from: '', to: '', city: '', storeId: '', partNumber: '' });
  const [filters, setFilters] = useState({});
  const [cursor, setCursor] = useState(null);
  const [cursorStack, setCursorStack] = useState([]);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [streamState, setStreamState] = useState('connecting');
  const requestSequence = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      const sequence = ++requestSequence.current;
      if (!quiet) setLoading(true);
      try {
        const [records, syncStatus] = await Promise.all([
          api.observations({
            ...filters,
            limit: 100,
            direction: 'desc',
            cursor: cursor || undefined,
          }),
          api.status(),
        ]);
        if (sequence !== requestSequence.current) return;
        setData(records);
        setStatus(syncStatus);
        setError('');
      } catch (failure) {
        if (sequence === requestSequence.current) setError(failure.message);
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    },
    [cursor, filters]
  );

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => subscribeApplePurchaseInventory(() => load(true), setStreamState), [load]);

  const apply = event => {
    event.preventDefault();
    setFilters({
      from: utc(draft.from),
      to: utc(draft.to),
      city: draft.city.trim() || undefined,
      storeId: draft.storeId.trim() || undefined,
      partNumber: draft.partNumber.trim() || undefined,
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
          <h1 className="text-2xl font-bold text-gray-900">ApplePurchase 有货记录</h1>
          <p className="mt-1 text-sm text-gray-500">
            永久历史按检测时间展示；实时提示只触发增量查询。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`badge ${streamState === 'connected' ? 'badge-success' : 'badge-warning'}`}
          >
            {streamState === 'connected' ? (
              <Radio className="mr-1 h-4 w-4" />
            ) : (
              <RadioTower className="mr-1 h-4 w-4" />
            )}
            {streamState === 'connected' ? '实时已连接' : '实时重连中'}
          </span>
          <button className="btn btn-secondary" onClick={() => load()} disabled={loading}>
            <RefreshCw className={`mr-1 inline h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {(status?.items || []).map(item => (
          <div className="card" key={item.terminalId}>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-gray-900">{item.name}</span>
              <span className={`badge ${item.enabled ? 'badge-success' : 'badge-error'}`}>
                {item.enabled ? '已启用' : '已禁用'}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-500">
              <span>最后成功</span>
              <span className="text-right text-gray-700">{beijingTime(item.lastSuccessAt)}</span>
              <span>有货高水位</span>
              <span className="text-right font-mono text-gray-700">
                {item.highWater.observations}
              </span>
            </div>
          </div>
        ))}
      </div>

      <form className="card" onSubmit={apply}>
        <div className="apple-purchase-filters">
          <input
            className="input"
            type="datetime-local"
            value={draft.from}
            onChange={event => setDraft({ ...draft, from: event.target.value })}
            aria-label="检测开始时间"
          />
          <input
            className="input"
            type="datetime-local"
            value={draft.to}
            onChange={event => setDraft({ ...draft, to: event.target.value })}
            aria-label="检测结束时间"
          />
          <input
            className="input"
            value={draft.city}
            onChange={event => setDraft({ ...draft, city: event.target.value })}
            placeholder="城市（精确）"
          />
          <input
            className="input"
            value={draft.storeId}
            onChange={event => setDraft({ ...draft, storeId: event.target.value })}
            placeholder="门店 ID（精确）"
          />
          <input
            className="input"
            value={draft.partNumber}
            onChange={event => setDraft({ ...draft, partNumber: event.target.value })}
            placeholder="Part Number（精确）"
          />
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
            正在加载有货记录…
          </p>
        ) : data?.items?.length ? (
          <table className="apple-purchase-table">
            <thead>
              <tr>
                <th>检测时间（北京时间）</th>
                <th>城市／门店</th>
                <th>商品</th>
                <th>规格</th>
                <th>料号</th>
                <th>终端</th>
                <th>序号</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(item => (
                <tr key={`${item.terminalId}:${item.observationId}`}>
                  <td>{beijingTime(item.responseReceivedAt)}</td>
                  <td>
                    {item.city || '—'} · {item.storeName}
                  </td>
                  <td>{item.productName}</td>
                  <td>{item.specification}</td>
                  <td className="font-mono text-xs">{item.partNumber}</td>
                  <td className="font-mono text-xs">{item.terminalId.slice(0, 8)}…</td>
                  <td className="font-mono text-xs">{item.sequence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="py-12 text-center text-gray-500">
            <PackageCheck className="mx-auto mb-2 h-10 w-10 text-gray-300" />
            <p>当前筛选下没有有货记录</p>
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
