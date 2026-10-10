import ResponsiveSelect from './responsiveSelect';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Maximize2, Minimize2, RefreshCw, Search, ScrollText, X } from 'lucide-react';
import client from '../api/client';
import MonitorLogAccountSelect from './MonitorLogAccountSelect';
import { copyDeferredText } from '../utils/copyDeferredText';

const BASE = '/server-monitor/logs';
const PAGE_SIZE = 100;
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
export default function MonitorLogs({ standalone = false }) {
  const Heading = standalone ? 'h1' : 'h2';
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [filters, setFilters] = useState(initial);
  const [draft, setDraft] = useState({
    account: '',
    fromTime: '',
    toTime: '',
    keyword: '',
  });
  const [accounts, setAccounts] = useState([]);
  const [accountError, setAccountError] = useState('');
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountAfter, setAccountAfter] = useState('');
  const [accountNext, setAccountNext] = useState(null);
  const [cursor, setCursor] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [wrapLines, setWrapLines] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [readingExpanded, setReadingExpanded] = useState(false);
  const [readerHeight, setReaderHeight] = useState(420);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState(null);
  const [scope, setScope] = useState('account');
  const [context, setContext] = useState(null);
  const [contextError, setContextError] = useState('');
  const [contextRefresh, setContextRefresh] = useState(0);
  const dialogRef = useRef(null);
  const contextTriggerRef = useRef(null);
  const logScrollRef = useRef(null);
  const loadMoreRef = useRef(null);
  const sectionRef = useRef(null);
  const readerPanelRef = useRef(null);
  const expandTriggerRef = useRef(null);
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
        const response = await client.get(`${BASE}/states`, {
          signal: controller.signal,
        });
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
    if (!cursor) setResult(null);
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
          params: {
            ...JSON.parse(filterKey),
            cursor: cursor || undefined,
            limit: PAGE_SIZE,
          },
          signal: controller.signal,
        });
        if (active) {
          setResult(previous => {
            if (!cursor || !previous) return response.data;
            const known = new Set(previous.items.map(row => row.id));
            return {
              ...response.data,
              items: [...previous.items, ...response.data.items.filter(row => !known.has(row.id))],
            };
          });
        }
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

  useLayoutEffect(() => {
    if (readingExpanded) return undefined;
    let frame;
    function measure() {
      const viewport = window.visualViewport;
      const top = readerPanelRef.current?.getBoundingClientRect().top ?? 0;
      const height = Math.max(
        420,
        Math.floor(
          (viewport?.height ?? window.innerHeight) -
            Math.max(16, top - (viewport?.offsetTop ?? 0)) -
            16
        )
      );
      setReaderHeight(current => (current === height ? current : height));
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    measure();
    const observer = new ResizeObserver(schedule);
    if (sectionRef.current) observer.observe(sectionRef.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true });
    window.visualViewport?.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
    };
  }, [readingExpanded]);

  useEffect(() => {
    if (!readingExpanded) return undefined;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    readerPanelRef.current?.querySelector('button')?.focus({ preventScroll: true });
    function handleKey(event) {
      // 详情侧栏拥有自己的焦点与 Esc 处理，先关闭最上层。
      if (dialogRef.current) return;
      if (event.key === 'Escape') setReadingExpanded(false);
      if (event.key !== 'Tab') return;
      const controls = [
        ...readerPanelRef.current.querySelectorAll('button, input, [tabindex="0"]'),
      ].filter(element => !element.disabled && element.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', handleKey);
      expandTriggerRef.current?.focus({ preventScroll: true });
    };
  }, [readingExpanded]);

  useEffect(() => {
    const nextCursor = result?.nextCursor;
    if (loading || error || drawerOpen || !nextCursor || nextCursor === cursor) return undefined;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) setCursor(nextCursor);
      },
      { root: logScrollRef.current, rootMargin: '0px 0px 400px 0px' }
    );
    if (loadMoreRef.current) observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [result?.nextCursor, loading, error, cursor, drawerOpen]);

  useEffect(() => {
    if (!filters.deviceId || !filters.localId || draft.account === '__unassigned__') {
      setAccountsLoading(false);
      setAccounts([]);
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    setAccountError('');
    setAccountsLoading(true);
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
          setAccountError(e.message || '账号候选读取失败');
        }
      } finally {
        if (active) setAccountsLoading(false);
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
    if (!drawerOpen || !selected) return undefined;
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
    return () => {
      active = false;
      controller.abort();
    };
  }, [drawerOpen, selected, scope, contextRefresh]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector('button')?.focus({ preventScroll: true });
    function handleKey(event) {
      if (event.key === 'Escape') setDrawerOpen(false);
      if (event.key !== 'Tab') return;
      const controls = [
        ...dialogRef.current.querySelectorAll('button, input, select, summary, [tabindex="0"]'),
      ].filter(element => !element.disabled && element.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', handleKey);
      contextTriggerRef.current?.focus({ preventScroll: true });
    };
  }, [drawerOpen]);

  function resetReader() {
    setResult(null);
    setSelected(null);
    setDrawerOpen(false);
    setCursor('');
    setNotice('');
    if (logScrollRef.current) logScrollRef.current.scrollTop = 0;
  }
  function reload() {
    resetReader();
    setRefresh(value => value + 1);
  }

  function change(field, value) {
    resetReader();
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
    resetReader();
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
  function highlighted(message) {
    const keyword = filters.keyword.trim();
    if (!keyword) return message;
    return message.split(keyword).map((part, index) => (
      <span key={index}>
        {index > 0 && <mark className="rounded-sm bg-amber-100 text-gray-900">{keyword}</mark>}
        {part}
      </span>
    ));
  }
  function rows(items, inContext = false) {
    return (
      <table
        className={`w-full border-collapse text-left font-mono text-[13px] leading-[22px] ${wrapLines ? 'table-fixed' : ''}`}
        aria-label={inContext ? '上下文日志列表' : '日志原文列表'}
      >
        <caption className="sr-only">序号仅表示当前列表位置，原始文件与行号请查看详情。</caption>
        <colgroup>
          <col style={{ width: 48 }} />
          <col />
        </colgroup>
        <tbody>
          {items.map((row, index) => (
            <tr
              key={row.id}
              className={`${row.id === selected?.id ? 'bg-primary-50' : 'hover:bg-gray-50'} group`}
            >
              <td className="w-12 select-none py-0.5 pr-2 text-right align-top text-xs text-gray-400">
                {index + 1}
              </td>
              <td className="p-0 align-top">
                {inContext ? (
                  <pre
                    className={`px-2 py-0.5 font-mono ${wrapLines ? 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]' : 'whitespace-pre'}`}
                  >
                    {highlighted(row.message.replace(/\r?\n$/, '') || '（空行）')}
                  </pre>
                ) : (
                  <button
                    type="button"
                    aria-label={`选择第${index + 1}条日志`}
                    aria-pressed={selected?.id === row.id}
                    className="block w-full select-text px-2 py-3 sm:py-0.5 text-left text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                    onClick={() => {
                      setSelected(row);
                      setNotice('');
                    }}
                  >
                    <span
                      className={`block ${wrapLines ? 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]' : 'whitespace-pre'}`}
                    >
                      {highlighted(row.message.replace(/\r?\n$/, '') || '（空行）')}
                    </span>
                    {PARSE[row.parseState] && (
                      <span className="ml-2 text-xs text-amber-700">[{PARSE[row.parseState]}]</span>
                    )}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <section ref={sectionRef} className="space-y-4" aria-label="完整日志查询">
      <div>
        <Heading
          className={`flex items-center gap-2 text-gray-900 ${standalone ? 'text-2xl font-bold' : 'text-lg font-semibold'}`}
        >
          {standalone && <ScrollText className="h-5 w-5" aria-hidden="true" />}
          日志查询
        </Heading>
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="min-w-0 break-words text-gray-600">
          {chosenDevice?.name || '未选择服务器'} / {activeInstance?.label || '未选择实例'} ·{' '}
          {filters.date}
          {filters.account &&
            ` · 账号 ${filters.account === '__unassigned__' ? '未识别' : filters.account}`}
          {(filters.fromTime || filters.toTime) &&
            ` · ${filters.fromTime || '00:00:00'}—${filters.toTime || '23:59:59'}`}
          {filters.keyword && ` · 关键词：${filters.keyword}`}
        </p>
        <button
          type="button"
          className="btn btn-secondary shrink-0"
          aria-expanded={filtersOpen}
          aria-controls="log-query-filters"
          onClick={() => setFiltersOpen(value => !value)}
        >
          {filtersOpen ? '收起筛选' : '修改筛选'}
        </button>
      </div>
      <form
        id="log-query-filters"
        hidden={!filtersOpen}
        onSubmit={submit}
        className="rounded-lg border border-gray-200 bg-white p-4"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm text-gray-600">
            服务器
            <ResponsiveSelect
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
            </ResponsiveSelect>
          </label>
          <label className="text-sm text-gray-600">
            软件实例
            <ResponsiveSelect
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
            </ResponsiveSelect>
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
          <div className="text-sm text-gray-600">
            <span>账号编号</span>
            <MonitorLogAccountSelect
              value={draft.account === '__unassigned__' ? '' : draft.account}
              options={accounts}
              loading={accountsLoading}
              error={accountError}
              disabled={!filtersOpen || !filters.localId || draft.account === '__unassigned__'}
              nextCursor={accountNext}
              hasPrevious={Boolean(accountAfter)}
              onChange={account => {
                if (account === draft.account) return;
                setDraft(value => ({ ...value, account }));
                setAccounts([]);
                setAccountNext(null);
                setAccountAfter('');
              }}
              onNext={() => {
                setAccounts([]);
                setAccountAfter(accountNext);
              }}
              onFirst={() => {
                setAccounts([]);
                setAccountAfter('');
              }}
            />
          </div>
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
              setDraft(value => ({
                ...value,
                account: e.target.checked ? '__unassigned__' : '',
              }));
              setAccountAfter('');
            }}
          />
          仅查看未识别账号的日志
        </label>
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
              reload();
            }}
          >
            清空筛选
          </button>
          <button
            type="button"
            className="btn btn-secondary inline-flex items-center justify-center min-h-11 sm:min-h-0"
            disabled={loading}
            onClick={reload}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            重新查询（从头）
          </button>
        </div>
      </form>
      {filters.localId && (
        <details
          className="rounded-lg border border-blue-100 bg-primary-50 px-3 py-2 text-sm text-gray-700"
          aria-label="日志采集状态"
        >
          <summary className="cursor-pointer leading-6">
            {!snapshot
              ? '等待新版采集器接入'
              : !activeInstance.fresh
                ? '采集状态已过期'
                : STATE[snapshot.state] || snapshot.state}
            {snapshot && ` · 待上传 ${snapshot.pending} 个片段`}
            {snapshot &&
              (snapshot.state !== 'ready' || !activeInstance.fresh) &&
              ' · 查询结果可能尚不完整'}
            {chosenDevice?.enabled === false && ' · 设备已停用'}
            <span className="ml-2 text-xs text-primary">采集详情</span>
          </summary>
          {snapshot && (
            <div className="mt-2 space-y-1 border-t border-blue-100 pt-2 text-xs leading-5">
              <p>
                扫描时间：{time(activeInstance.observedAt)} · 发现 {snapshot.fileCount} 个文件 ·
                已读 {size(snapshot.scannedBytes)} / {size(snapshot.totalBytes)} · 异常{' '}
                {snapshot.issues} · 本机过期未传 {snapshot.expired}
              </p>
              <p>本机现存日期：{snapshot.dates?.join('、') || '无'}。</p>
              <p>
                {snapshot.dates?.includes(filters.date)
                  ? '文件存在不代表当天完整。补采可能插入较早日志，补采结束后请重新查询。'
                  : '所选日期未发现现存文件；已删除历史无法从本机补采。'}
              </p>
            </div>
          )}
        </details>
      )}
      {readingExpanded && <div style={{ height: readerHeight }} aria-hidden="true" />}
      <div
        ref={readerPanelRef}
        role={readingExpanded ? 'dialog' : undefined}
        aria-modal={readingExpanded ? true : undefined}
        aria-label={readingExpanded ? '专注日志阅读' : undefined}
        className={`flex flex-col overflow-hidden border border-gray-200 bg-white ${readingExpanded ? 'fixed inset-0 z-50 !m-0 h-[100dvh]' : 'rounded-lg'}`}
        style={readingExpanded ? undefined : { height: readerHeight }}
      >
        {readingExpanded && (
          <div className="shrink-0 border-b border-gray-200 px-3 py-2 text-sm text-gray-600">
            <span className="mr-2 font-semibold text-gray-900">专注阅读</span>
            {chosenDevice?.name} / {activeInstance?.label} · {filters.date}
            {filters.account &&
              ` · 账号 ${filters.account === '__unassigned__' ? '未识别' : filters.account}`}
            {(filters.fromTime || filters.toTime) &&
              ` · ${filters.fromTime || '00:00:00'}—${filters.toTime || '23:59:59'}`}
            {filters.keyword && ` · 关键词：${filters.keyword}`}
          </div>
        )}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-secondary inline-flex min-h-11 items-center gap-1 sm:min-h-0"
              onClick={event => {
                if (!readingExpanded) expandTriggerRef.current = event.currentTarget;
                setReadingExpanded(value => !value);
              }}
            >
              {readingExpanded ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
              {readingExpanded ? '退出阅读' : '展开阅读'}
            </button>
            <button
              type="button"
              className="btn btn-secondary inline-flex items-center gap-1"
              disabled={!selected}
              onClick={() => copy(selected.message)}
            >
              <Copy className="h-4 w-4" />
              复制选中日志
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!selected}
              onClick={event => {
                contextTriggerRef.current = event.currentTarget;
                setScope(selected.accountNumber ? 'account' : 'instance');
                setDrawerOpen(true);
              }}
            >
              详情与上下文
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={loading || !filters.localId}
              onClick={reload}
              aria-label="重新查询日志，从头加载"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          <label className="inline-flex min-h-8 items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={wrapLines}
              onChange={event => setWrapLines(event.target.checked)}
            />
            自动换行
          </label>
        </div>
        <div className="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-1 border-b border-gray-100 px-3 py-1 text-xs text-gray-500">
          <span>
            {selected
              ? `已选中 · 账号 ${selected.accountNumber ?? '未识别'} · 原文复制保留换行`
              : '点击一条日志选择；序号为列表位置，文件来源见详情'}
          </span>
          <span role="status" className="text-primary">
            {notice}
          </span>
        </div>
        {error && (
          <p
            role="alert"
            className="flex shrink-0 flex-wrap items-center gap-2 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
            {result ? (
              <span>已加载日志保留，可重试加载更多。</span>
            ) : (
              <button type="button" className="underline" onClick={reload}>
                重新查询
              </button>
            )}
          </p>
        )}
        <div
          ref={logScrollRef}
          role="region"
          aria-label="日志阅读区"
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto overscroll-contain text-gray-700"
          style={{ overflowAnchor: 'none' }}
          aria-busy={loading}
        >
          {result?.items.length ? (
            rows(result.items)
          ) : loading ? (
            <p className="p-8 text-center text-sm text-gray-500">正在读取日志…</p>
          ) : !filters.localId ? (
            <p className="p-8 text-center text-sm text-gray-500">
              请选择服务器和软件实例查看日志。
            </p>
          ) : !error && result ? (
            <p className="p-8 text-center text-sm text-gray-500">
              当前条件下没有已上传的日志，请核对筛选条件和采集状态。
            </p>
          ) : null}
          <div ref={loadMoreRef} className="h-px" aria-hidden="true" />
        </div>
        {result && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-3 py-2 text-sm">
            <span className="text-gray-500">
              已加载 {result.items.length} 个片段
              {result.nextCursor ? ' · 下滑自动加载' : ' · 已到当前结果末尾'}
            </span>
            {result.nextCursor && (
              <button
                type="button"
                className="btn btn-secondary min-h-11 sm:min-h-0"
                disabled={loading}
                onClick={() => {
                  if (error) setRefresh(value => value + 1);
                  else setCursor(result.nextCursor);
                }}
              >
                {loading ? '正在加载…' : error ? '重试加载更多' : '加载更多'}
              </button>
            )}
          </div>
        )}
      </div>
      {drawerOpen && selected && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-gray-900/20"
          onClick={event => {
            if (event.target === event.currentTarget) setDrawerOpen(false);
          }}
        >
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="log-detail-title"
            className="flex h-[100dvh] w-full max-w-3xl flex-col bg-white shadow-xl"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
              <h3 id="log-detail-title" className="font-semibold text-gray-900">
                日志详情与上下文
              </h3>
              <button
                type="button"
                aria-label="关闭日志详情"
                className="btn btn-secondary"
                onClick={() => setDrawerOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-gray-500">日志时间</dt>
                <dd>{time(selected.loggedAt)}</dd>
                <dt className="text-gray-500">账号</dt>
                <dd>{selected.accountNumber ?? '未识别'}</dd>
                <dt className="text-gray-500">来源文件</dt>
                <dd className="break-all">{selected.fileName}</dd>
                <dt className="text-gray-500">原始位置</dt>
                <dd>
                  第 {selected.lineNumber} 行 · 第 {selected.partIndex + 1} 段
                </dd>
                <dt className="text-gray-500">文件版本</dt>
                <dd className="break-all font-mono text-xs">{selected.fileId}</dd>
                {PARSE[selected.parseState] && (
                  <>
                    <dt className="text-gray-500">格式说明</dt>
                    <dd className="text-amber-700">{PARSE[selected.parseState]}</dd>
                  </>
                )}
              </dl>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-sm font-medium">选中原文</h4>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => copy(selected.message)}
                  >
                    复制原文
                  </button>
                </div>
                <pre className="max-h-64 overflow-auto rounded border border-gray-200 bg-gray-50 p-2 font-mono text-[13px] leading-6 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {highlighted(selected.message || '（空片段）')}
                </pre>
                <p role="status" className="mt-1 text-xs text-primary">
                  {notice}
                </p>
                {selected.rawBase64 && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-amber-700">
                      查看原始字节（Base64）
                    </summary>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">
                      {selected.rawBase64}
                    </pre>
                  </details>
                )}
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-medium">上下文 · 同一天前后各20个片段</h4>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={`btn ${scope === 'account' ? 'btn-primary' : 'btn-secondary'}`}
                    disabled={!selected.accountNumber}
                    onClick={() => setScope('account')}
                  >
                    该账号上下文
                  </button>
                  <button
                    type="button"
                    className={`btn ${scope === 'instance' ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setScope('instance')}
                  >
                    整个实例上下文
                  </button>
                </div>
                {contextError ? (
                  <p role="alert" className="text-sm text-red-700">
                    {contextError}
                    <button
                      type="button"
                      className="ml-2 underline"
                      onClick={() => setContextRefresh(value => value + 1)}
                    >
                      重试上下文
                    </button>
                  </p>
                ) : context ? (
                  <div className="overflow-auto rounded border border-gray-200">
                    {rows(context.items, true)}
                  </div>
                ) : (
                  <p className="p-4 text-sm text-gray-500">正在读取上下文…</p>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
