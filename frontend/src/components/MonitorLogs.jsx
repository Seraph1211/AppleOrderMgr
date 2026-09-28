import { useEffect, useRef, useState } from 'react';
import { Copy, RefreshCw, Search, X } from 'lucide-react';
import client from '../api/client';
import { copyDeferredText } from '../utils/copyDeferredText';

const BASE = '/server-monitor/logs';
const day = offset =>
  new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
const time = value =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
      })
    : '无时间戳';
const STATE = {
  ready: '已扫描',
  catching_up: '采集／补传中',
  backpressure: '本地队列积压',
  missing: '未找到日志文件',
  unreadable: '存在无法读取的文件',
  error: '采集异常',
};
const PARSE = {
  continuation: 'XML 续行',
  unparsed: '未识别格式',
  encoding_error: '编码异常，已保留原始字节',
};
const size = bytes => `${(Number(bytes || 0) / 1048576).toFixed(2)} MiB`;
const initial = () => ({
  deviceId: '',
  localId: '',
  date: day(0),
  account: '',
  fromTime: '',
  toTime: '',
  keyword: '',
});

/** 完整日志筛选与上下文；原文只作为文本渲染。 */
export default function MonitorLogs() {
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [filters, setFilters] = useState(initial);
  const [draft, setDraft] = useState({ account: '', fromTime: '', toTime: '', keyword: '' });
  const [accounts, setAccounts] = useState([]);
  const [accountError, setAccountError] = useState('');
  const [accountAfter, setAccountAfter] = useState('');
  const [accountNext, setAccountNext] = useState(null);
  const [cursors, setCursors] = useState(['']);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState(null);
  const [scope, setScope] = useState('account');
  const [context, setContext] = useState(null);
  const [contextError, setContextError] = useState('');
  const contextRef = useRef(null);
  const cursor = cursors.at(-1);
  const filterKey = JSON.stringify(filters);
  const activeInstance = catalog?.instances.find(
    row => row.deviceId === filters.deviceId && row.localId === filters.localId
  );
  const snapshot = activeInstance?.snapshot;
  const chosenDevice = catalog?.devices.find(row => row.id === filters.deviceId);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function read() {
      try {
        const response = await client.get(`${BASE}/states`, { signal: controller.signal });
        if (active) {
          setCatalog(response.data);
          setCatalogError('');
        }
      } catch (e) {
        if (active) setCatalogError(e.message || '采集状态读取失败');
      }
    }
    read();
    const timer = setInterval(read, 60000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    setResult(null);
    setError('');
    if (!filters.deviceId || !filters.localId) {
      setLoading(false);
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    async function read() {
      try {
        const response = await client.get(BASE, {
          params: { ...JSON.parse(filterKey), cursor, limit: 50 },
          signal: controller.signal,
        });
        if (active) setResult(response.data);
      } catch (e) {
        if (active) setError(e.message || '日志读取失败');
      } finally {
        if (active) setLoading(false);
      }
    }
    read();
    return () => {
      active = false;
      controller.abort();
    };
  }, [filterKey, cursor, refresh, filters.deviceId, filters.localId]);

  useEffect(() => {
    if (!filters.deviceId || !filters.localId) {
      setAccounts([]);
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    setAccountError('');
    const timer = setTimeout(async () => {
      try {
        const response = await client.get(`${BASE}/accounts`, {
          params: {
            deviceId: filters.deviceId,
            localId: filters.localId,
            date: filters.date,
            search: draft.account === '__unassigned__' ? '' : draft.account,
            after: accountAfter,
          },
          signal: controller.signal,
        });
        if (active) {
          setAccounts(response.data.items);
          setAccountNext(response.data.nextCursor);
        }
      } catch (e) {
        if (active) {
          setAccounts([]);
          setAccountNext(null);
          setAccountError(e.message || '账号候选读取失败，可直接输入编号');
        }
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [filters.deviceId, filters.localId, filters.date, draft.account, accountAfter, refresh]);

  useEffect(() => {
    setContext(null);
    setContextError('');
    if (!selected) return undefined;
    let active = true;
    const controller = new AbortController();
    async function read() {
      try {
        const response = await client.get(`${BASE}/${selected.id}/context`, {
          params: { scope },
          signal: controller.signal,
        });
        if (active) setContext(response.data);
      } catch (e) {
        if (active) setContextError(e.message || '上下文读取失败');
      }
    }
    read();
    contextRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return () => {
      active = false;
      controller.abort();
    };
  }, [selected, scope, refresh]);

  function change(field, value) {
    setResult(null);
    setSelected(null);
    setCursors(['']);
    setNotice('');
    setAccounts([]);
    setAccountAfter('');
    setAccountNext(null);
    setFilters(current => ({
      ...current,
      [field]: value,
      ...(field === 'deviceId' ? { localId: '' } : {}),
      account: '',
    }));
    setDraft(current => ({ ...current, account: '' }));
  }
  function submit(event) {
    event.preventDefault();
    setResult(null);
    setSelected(null);
    setCursors(['']);
    setNotice('');
    setFilters(current => ({
      ...current,
      ...draft,
      fromTime: draft.fromTime.length === 5 ? `${draft.fromTime}:00` : draft.fromTime,
      toTime: draft.toTime.length === 5 ? `${draft.toTime}:00` : draft.toTime,
    }));
    setRefresh(value => value + 1);
  }
  async function copy(text) {
    try {
      await copyDeferredText(() => text);
      setNotice('日志已复制');
    } catch (e) {
      setNotice(e.message || '复制失败');
    }
  }
  function rows(items, inContext = false) {
    return (
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full min-w-[680px] table-fixed text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th className="w-44 p-3">时间／账号</th>
              <th className="p-3">完整日志正文</th>
              <th className="w-28 p-3">操作</th>
            </tr>
          </thead>
          <tbody className="bg-white">
            {items.map(row => (
              <tr
                key={row.id}
                className={`border-t border-gray-200 ${row.id === context?.anchorId ? 'bg-primary-50' : 'hover:bg-gray-50'}`}
              >
                <td className="p-3 align-top break-words">
                  <div>{time(row.loggedAt)}</div>
                  <div className="mt-1 font-medium">账号 {row.accountNumber ?? '未识别'}</div>
                  <div className="mt-2 text-xs text-gray-500">
                    {row.fileName}
                    <br />第 {row.lineNumber} 行 · 第 {row.partIndex + 1} 段<br />
                    版本 {row.fileId.slice(0, 8)}
                  </div>
                  {PARSE[row.parseState] && (
                    <span className="text-xs text-amber-700">{PARSE[row.parseState]}</span>
                  )}
                </td>
                <td className="p-3 align-top">
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-6 text-gray-700">
                    {row.message || '（空片段）'}
                  </pre>
                  {row.rawBase64 && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-amber-700">
                        查看原始字节（Base64）
                      </summary>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">
                        {row.rawBase64}
                      </pre>
                    </details>
                  )}
                </td>
                <td className="p-3 align-top">
                  <div className="flex flex-col gap-2">
                    <button
                      className="btn btn-secondary inline-flex items-center justify-center min-h-11 sm:min-h-0"
                      onClick={() => copy(row.message)}
                      aria-label={`复制第${row.lineNumber}行第${row.partIndex + 1}段`}
                    >
                      <Copy className="mr-1 h-4 w-4" />
                      复制
                    </button>
                    {!inContext && (
                      <button
                        className="btn btn-secondary inline-flex items-center justify-center min-h-11 sm:min-h-0"
                        onClick={() => {
                          setScope(row.accountNumber ? 'account' : 'instance');
                          setSelected(row);
                        }}
                      >
                        上下文
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <section className="space-y-4" aria-label="完整日志查询">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">日志查询</h2>
        <p className="mt-1 text-sm text-gray-500">
          北京时间 · 最近30天 · 正常在线约1分钟同步 · 原始内容按文件位置保留，长行分段展示
        </p>
      </div>
      {catalogError && (
        <p role="alert" className="text-sm text-red-700">
          {catalogError}{' '}
          <button className="underline" onClick={() => setRefresh(value => value + 1)}>
            重试
          </button>
        </p>
      )}
      {!catalog && !catalogError && <p className="text-gray-500">正在读取服务器与实例…</p>}
      <form onSubmit={submit} className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm text-gray-600">
            服务器
            <select
              className="input mt-1 w-full text-base sm:text-sm"
              aria-label="服务器"
              value={filters.deviceId}
              onChange={e => change('deviceId', e.target.value)}
            >
              <option value="">请选择服务器</option>
              {catalog?.devices.map(device => (
                <option key={device.id} value={device.id}>
                  {device.name}
                  {device.enabled ? '' : '（已停用）'}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-600">
            软件实例
            <select
              className="input mt-1 w-full text-base sm:text-sm"
              aria-label="软件实例"
              value={filters.localId}
              disabled={!filters.deviceId}
              onChange={e => change('localId', e.target.value)}
            >
              <option value="">请选择实例</option>
              {catalog?.instances
                .filter(item => item.deviceId === filters.deviceId)
                .map(item => (
                  <option key={item.localId} value={item.localId}>
                    {item.label}
                    {item.active === false ? '（已移除）' : ''}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm text-gray-600">
            日志日期
            <input
              className="input mt-1 w-full text-base sm:text-sm"
              type="date"
              min={day(-29)}
              max={day(0)}
              required
              aria-label="日志日期"
              value={filters.date}
              onChange={e => change('date', e.target.value)}
            />
          </label>
          <label className="text-sm text-gray-600">
            账号编号
            <input
              className="input mt-1 w-full text-base sm:text-sm"
              list="monitor-log-accounts"
              placeholder="全部账号，或输入编号"
              aria-label="账号编号"
              disabled={draft.account === '__unassigned__'}
              value={draft.account === '__unassigned__' ? '' : draft.account}
              onChange={e => {
                setDraft(value => ({ ...value, account: e.target.value }));
                setAccountAfter('');
              }}
            />
            <datalist id="monitor-log-accounts">
              {accounts.map(account => (
                <option key={account} value={account} />
              ))}
            </datalist>
          </label>
          <label className="text-sm text-gray-600">
            开始时间
            <input
              type="time"
              step="1"
              className="input mt-1 w-full text-base sm:text-sm"
              aria-label="开始时间"
              value={draft.fromTime}
              onChange={e => setDraft(value => ({ ...value, fromTime: e.target.value }))}
            />
          </label>
          <label className="text-sm text-gray-600">
            结束时间
            <input
              type="time"
              step="1"
              className="input mt-1 w-full text-base sm:text-sm"
              aria-label="结束时间"
              value={draft.toTime}
              onChange={e => setDraft(value => ({ ...value, toTime: e.target.value }))}
            />
          </label>
          <label className="text-sm text-gray-600 sm:col-span-2">
            正文关键词
            <input
              className="input mt-1 w-full text-base sm:text-sm"
              maxLength={200}
              placeholder="例如：加入购物车、店铺编号"
              aria-label="正文关键词"
              value={draft.keyword}
              onChange={e => setDraft(value => ({ ...value, keyword: e.target.value }))}
            />
          </label>
        </div>
        <label className="mt-3 inline-flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={draft.account === '__unassigned__'}
            onChange={e => {
              setDraft(value => ({ ...value, account: e.target.checked ? '__unassigned__' : '' }));
              setAccountAfter('');
            }}
          />
          仅查看未识别账号的日志
        </label>
        {accountError && <p className="mt-2 text-xs text-amber-700">{accountError}</p>}
        {(accountNext || accountAfter) && (
          <div className="mt-2 flex gap-3 text-xs text-primary">
            {accountAfter && (
              <button type="button" onClick={() => setAccountAfter('')}>
                账号候选首页
              </button>
            )}
            {accountNext && (
              <button type="button" onClick={() => setAccountAfter(accountNext)}>
                下一组账号候选
              </button>
            )}
            <span>也可直接输入完整账号编号</span>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="btn btn-primary inline-flex items-center justify-center min-h-11 sm:min-h-0"
            disabled={!filters.localId || loading}
          >
            <Search className="mr-1 h-4 w-4" />
            查询
          </button>
          <button
            type="button"
            className="btn btn-secondary inline-flex items-center justify-center min-h-11 sm:min-h-0"
            onClick={() => {
              setDraft({ account: '', fromTime: '', toTime: '', keyword: '' });
              setFilters(value => ({
                ...value,
                account: '',
                fromTime: '',
                toTime: '',
                keyword: '',
              }));
              setCursors(['']);
              setSelected(null);
            }}
          >
            清空筛选
          </button>
          <button
            type="button"
            className="btn btn-secondary inline-flex items-center justify-center min-h-11 sm:min-h-0"
            disabled={loading}
            onClick={() => setRefresh(value => value + 1)}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            刷新当前页
          </button>
        </div>
      </form>
      {filters.localId && (
        <div
          className="rounded-lg border border-blue-100 bg-primary-50 p-3 text-sm text-gray-700"
          aria-label="日志采集状态"
        >
          <p>
            {chosenDevice?.name} / {activeInstance?.label} ·{' '}
            {!snapshot
              ? '等待新版采集器接入'
              : !activeInstance.fresh
                ? '采集状态已过期，已上传日志仍可查询'
                : STATE[snapshot.state] || snapshot.state}
            {chosenDevice?.enabled === false ? ' · 设备已停用' : ''}
          </p>
          {snapshot && (
            <>
              <p className="mt-1">
                扫描时间：{time(activeInstance.observedAt)} · 发现 {snapshot.fileCount} 个文件 ·
                已读 {size(snapshot.scannedBytes)} / {size(snapshot.totalBytes)} · 待上传{' '}
                {snapshot.pending} 个片段 · 异常 {snapshot.issues} · 本机过期未传 {snapshot.expired}
              </p>
              <p className="mt-1">
                本机现存日期：{snapshot.dates?.join('、') || '无'}。
                {snapshot.dates?.includes(filters.date)
                  ? '文件存在不代表当天完整，补采期间可刷新查看新增结果。'
                  : '所选日期未发现现存文件；已删除历史无法从本机补采。'}
              </p>
            </>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-primary">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}{' '}
          <button
            className="underline"
            onClick={() => {
              setCursors(['']);
              setRefresh(value => value + 1);
            }}
          >
            重新查询
          </button>
        </p>
      )}
      {loading ? (
        <p className="p-8 text-center text-gray-500">正在读取日志…</p>
      ) : !filters.localId ? (
        <p className="p-8 text-center text-gray-500">请选择服务器和软件实例查看日志。</p>
      ) : result?.items.length ? (
        rows(result.items)
      ) : (
        result && (
          <p className="p-8 text-center text-gray-500">
            当前条件下没有已上传的日志，请核对筛选条件和采集状态。
          </p>
        )
      )}
      {result && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>
            第 {cursors.length} 页 · 本页 {result.items.length} 个片段
          </span>
          <div className="flex gap-2">
            <button
              className="btn btn-secondary inline-flex items-center justify-center min-h-11 sm:min-h-0"
              disabled={loading || cursors.length === 1}
              onClick={() => {
                setSelected(null);
                setCursors(value => value.slice(0, -1));
              }}
            >
              上一页
            </button>
            <button
              className="btn btn-secondary inline-flex items-center justify-center min-h-11 sm:min-h-0"
              disabled={loading || !result.nextCursor}
              onClick={() => {
                setSelected(null);
                setCursors(value => [...value, result.nextCursor]);
              }}
            >
              下一页
            </button>
          </div>
        </div>
      )}
      {selected && (
        <section
          ref={contextRef}
          className="space-y-3 rounded-lg border border-gray-200 bg-white p-3"
          aria-label="日志上下文"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">日志上下文 · 前后各20个片段</h3>
            <button
              aria-label="关闭日志上下文"
              className="btn btn-secondary"
              onClick={() => setSelected(null)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={`btn ${scope === 'account' ? 'btn-primary' : 'btn-secondary'}`}
              disabled={!selected.accountNumber}
              onClick={() => setScope('account')}
            >
              该账号上下文
            </button>
            <button
              className={`btn ${scope === 'instance' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setScope('instance')}
            >
              整个实例上下文
            </button>
          </div>
          {contextError ? (
            <p role="alert" className="text-red-700">
              {contextError}
            </p>
          ) : context ? (
            rows(context.items, true)
          ) : (
            <p className="p-4 text-gray-500">正在读取上下文…</p>
          )}
        </section>
      )}
    </section>
  );
}
