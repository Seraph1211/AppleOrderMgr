import MonitorLogContextDrawer from './contextDrawer';
import MonitorLogMoreFilters from './moreFilters';
import MonitorLogDateTimeSelect from './dateTimeSelect';
import MonitorResourceSelect from './resourceSelect';
import './logQuery.css';
import MonitorLogTagsDialog from '../monitorLogTagsDialog';
import { useAuth } from '../../contexts/AuthContext';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Tag, Copy, Maximize2, Minimize2, RefreshCw, Search, ScrollText } from 'lucide-react';
import client from '../../api/client';
import MonitorLogAccountSelect from './accountSelect';
import { copyDeferredText } from '../../utils/copyDeferredText';

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
const rangeDefaults = () => ({ date: day(0), endDate: day(0), fromTime: '', toTime: '' });
const rangeParams = filters => ({
  startAt: `${filters.date}T${filters.fromTime || '00:00:00'}`,
  endAt: `${filters.endDate}T${filters.toTime || '23:59:59'}`,
  ...(filters.fromTime || filters.toTime ? { timeBasis: 'loggedAt' } : {}),
});
const initial = () => ({
  deviceId: '',
  localId: '',
  ...rangeDefaults(),
  account: '',
  keyword: '',
});

/** 完整日志筛选与上下文；原文只作为文本渲染。 */
export default function MonitorLogQuery() {
  const standalone = true;
  const { can } = useAuth();
  const canManageTags = can('monitor.manage');
  const [tagsOpen, setTagsOpen] = useState(false);
  const Heading = standalone ? 'h1' : 'h2';
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [filters, setFilters] = useState(initial);
  const [draft, setDraft] = useState(() => ({ ...rangeDefaults(), account: '', keyword: '' }));

  const [accounts, setAccounts] = useState([]);
  const [accountError, setAccountError] = useState('');
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountAfter, setAccountAfter] = useState('');
  const [accountNext, setAccountNext] = useState(null);
  const [cursor, setCursor] = useState('');
  const filtersOpen = true;
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
  const dialogRef = useRef(null);
  const contextTriggerRef = useRef(null);
  const logScrollRef = useRef(null);
  const loadMoreRef = useRef(null);
  const sectionRef = useRef(null);
  const readerPanelRef = useRef(null);
  const expandTriggerRef = useRef(null);
  const filterKey = JSON.stringify(filters);
  const accountRangeKey = JSON.stringify({
    deviceId: filters.deviceId,
    localId: filters.localId,
    ...rangeParams(filters),
  });
  const activeInstance = catalog?.instances.find(
    row => row.deviceId === filters.deviceId && row.localId === filters.localId
  );
  const displayResource = (name, tag) => (tag ? `${name} · ${tag}` : name);
  function updateTag(saved) {
    setCatalog(
      current =>
        current && {
          ...current,
          devices: current.devices.map(row =>
            !saved.localId && row.id === saved.deviceId
              ? { ...row, tag: saved.tag, tagVersion: saved.tagVersion }
              : row
          ),
          instances: current.instances.map(row =>
            saved.localId && row.deviceId === saved.deviceId && row.localId === saved.localId
              ? { ...row, tag: saved.tag, tagVersion: saved.tagVersion }
              : row
          ),
        }
    );
  }
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
    if (!cursor) {
      setResult(null);
      setError('');
    }
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
            deviceId: JSON.parse(filterKey).deviceId,
            localId: JSON.parse(filterKey).localId,
            account: JSON.parse(filterKey).account,
            keyword: JSON.parse(filterKey).keyword,
            ...rangeParams(JSON.parse(filterKey)),
            cursor: cursor || undefined,
            limit: PAGE_SIZE,
          },
          signal: controller.signal,
        });
        if (active) {
          setError('');
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
        280,
        Math.floor(
          (viewport?.height ?? window.innerHeight) -
            Math.max(16, top - (viewport?.offsetTop ?? 0)) -
            52
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
    readerPanelRef.current?.focus({ preventScroll: true });
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
      if (!readerPanelRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === readerPanelRef.current)
      ) {
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
      setAccountNext(null);
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
            ...JSON.parse(accountRangeKey),
            search: draft.account === '__unassigned__' ? '' : draft.account,
            cursor: accountAfter || undefined,
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
  }, [accountRangeKey, filters.deviceId, filters.localId, draft.account, accountAfter, refresh]);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus({ preventScroll: true });
    function handleKey(event) {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') setDrawerOpen(false);
      if (event.key !== 'Tab') return;
      const controls = [
        ...dialogRef.current.querySelectorAll('button, input, select, summary, [tabindex="0"]'),
      ].filter(element => !element.disabled && element.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialogRef.current)
      ) {
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
    if (loading) return;
    resetReader();
    setAccounts([]);
    setAccountNext(null);
    setAccountAfter('');
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
    <section ref={sectionRef} className="logs-query-page" aria-label="完整日志查询">
      <div className="logs-page-heading">
        <Heading
          className={`flex items-center gap-2 text-gray-900 ${standalone ? 'text-2xl font-bold' : 'text-lg font-semibold'}`}
        >
          {standalone && <ScrollText className="h-5 w-5" aria-hidden="true" />}
          日志查询
        </Heading>
        <p className="mt-1 text-sm text-gray-500">北京时间 · 最近90天</p>
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
      <div className="logs-scope-row flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="min-w-0 break-words text-gray-600">
          {displayResource(chosenDevice?.name, chosenDevice?.tag) || '未选择服务器'} /{' '}
          {displayResource(activeInstance?.label, activeInstance?.tag) || '未选择实例'} ·{' '}
          {filters.date === filters.endDate ? filters.date : `${filters.date}—${filters.endDate}`}
          {filters.account &&
            ` · 账号 ${filters.account === '__unassigned__' ? '未识别' : filters.account}`}
          {(filters.fromTime || filters.toTime) &&
            ` · ${filters.fromTime || '00:00:00'}—${filters.toTime || '23:59:59'}`}
          {filters.keyword && ` · 关键词：${filters.keyword}`}
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {canManageTags && (
            <button
              type="button"
              className="btn btn-secondary min-h-11 shrink-0 whitespace-nowrap sm:min-h-0"
              aria-haspopup="dialog"
              aria-controls="log-tag-management"
              disabled={!catalog}
              onClick={() => setTagsOpen(true)}
            >
              <Tag className="h-4 w-4" />
              标签管理
            </button>
          )}
        </div>
      </div>
      {canManageTags && catalog && (
        <MonitorLogTagsDialog
          open={tagsOpen}
          onClose={() => setTagsOpen(false)}
          catalog={catalog}
          onSaved={updateTag}
          onCatalog={setCatalog}
        />
      )}
      <form
        id="log-query-filters"
        hidden={!filtersOpen}
        onSubmit={submit}
        className="logs-filter-panel monitor-log-filter-form rounded-xl border border-gray-200 bg-white p-3 sm:p-4"
      >
        <div
          className="monitor-log-filter-scroll"
          role="region"
          aria-label="日志筛选条件"
          tabIndex={0}
        >
          <div className="logs-source-fields">
            <MonitorResourceSelect
              label="服务器"
              loading={!catalog && !catalogError}
              error={catalogError}
              placeholder="请选择服务器"
              value={filters.deviceId}
              onChange={value => change('deviceId', value)}
              options={[...(catalog?.devices || [])]
                .sort((a, b) => {
                  const priority = name => {
                    const match = /^US(?:\s+Server\s+(?:No\.)?)?0*(\d+)$/i.exec(name);
                    const number = match ? Number(match[1]) : 0;
                    return number >= 1 && number <= 10 ? number : 11;
                  };
                  return (
                    priority(a.name) - priority(b.name) ||
                    a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
                  );
                })
                .map(device => ({
                  value: device.id,
                  name: device.name,
                  tag: device.tag,
                  status: device.enabled ? '' : '已停用',
                  label: `${displayResource(device.name, device.tag)}${device.enabled ? '' : '（已停用）'}`,
                }))}
            />
            <MonitorResourceSelect
              label="软件实例"
              loading={!catalog && !catalogError}
              error={catalogError}
              placeholder="请选择实例"
              value={filters.localId}
              disabled={!filters.deviceId}
              onChange={value => change('localId', value)}
              options={(catalog?.instances || [])
                .filter(item => item.deviceId === filters.deviceId)
                .map(item => ({
                  value: item.localId,
                  name: item.label.replace('AOS 实例 ', 'AOS '),
                  tag: item.tag,
                  status: item.active === false ? '已移除' : '',
                  label: `${displayResource(item.label, item.tag)}${item.active === false ? '（已移除）' : ''}`,
                }))}
            />
          </div>
          <div className="logs-search-fields">
            <div className="monitor-log-filter-field monitor-filter-account">
              <span className="monitor-filter-label">账号编号</span>
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
            <MonitorLogDateTimeSelect
              date={draft.date}
              endDate={draft.endDate}
              fromTime={draft.fromTime}
              toTime={draft.toTime}
              minDate={catalog?.first || day(-89)}
              maxDate={catalog?.today || day(0)}
              onChange={(date, endDate, fromTime, toTime) =>
                setDraft(value => ({ ...value, date, endDate, fromTime, toTime }))
              }
            />
            <label className="monitor-log-filter-field logs-keyword-field">
              <span className="monitor-filter-label">正文关键词</span>
              <div className="monitor-filter-keyword-control">
                <Search className="monitor-filter-keyword-icon h-4 w-4" aria-hidden="true" />
                <input
                  className="input mt-1 w-full text-base sm:text-sm"
                  maxLength={200}
                  placeholder="搜索日志正文"
                  aria-label="正文关键词"
                  value={draft.keyword}
                  onChange={e => setDraft(value => ({ ...value, keyword: e.target.value }))}
                />
              </div>
            </label>
          </div>
        </div>
        <div className="monitor-log-filter-actions mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
          <div
            role="group"
            aria-label="日志查询操作"
            className="flex w-full flex-wrap items-center justify-end gap-2 sm:ml-auto sm:w-auto"
          >
            <button
              className="btn btn-primary inline-flex items-center justify-center min-h-11 sm:min-h-0"
              disabled={!filters.localId || loading}
              aria-label="查询日志"
            >
              <Search className="mr-1 h-4 w-4" />
              查询
            </button>
            <button
              type="button"
              className="btn btn-secondary inline-flex items-center justify-center min-h-11 sm:min-h-0"
              aria-label="重置条件"
              onClick={() => {
                setDraft({
                  date: filters.date,
                  endDate: filters.endDate,
                  account: '',
                  fromTime: '',
                  toTime: '',
                  keyword: '',
                });
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
              重置
            </button>
          </div>
        </div>
        <MonitorLogMoreFilters
          checked={draft.account === '__unassigned__'}
          onChange={checked => {
            setDraft(value => ({ ...value, account: checked ? '__unassigned__' : '' }));
            setAccountAfter('');
          }}
        />
      </form>
      {filters.localId && (
        <details
          className="logs-collection-state rounded-lg border border-blue-100 bg-primary-50 px-3 py-2 text-sm text-gray-700"
          data-collection-state={
            !snapshot ? 'unknown' : !activeInstance.fresh ? 'stale' : snapshot.state
          }
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
        tabIndex={-1}
        role={readingExpanded ? 'dialog' : undefined}
        aria-modal={readingExpanded ? true : undefined}
        aria-label={readingExpanded ? '专注日志阅读' : undefined}
        className={`logs-reader flex flex-col overflow-hidden border border-gray-200 bg-white ${readingExpanded ? 'fixed inset-0 z-50 !m-0 h-[100dvh]' : 'rounded-lg'}`}
        style={readingExpanded ? undefined : { height: readerHeight }}
      >
        {readingExpanded && (
          <div className="shrink-0 border-b border-gray-200 px-3 py-2 text-sm text-gray-600">
            <span className="mr-2 font-semibold text-gray-900">专注阅读</span>
            {chosenDevice?.name} / {activeInstance?.label} ·{' '}
            {filters.date === filters.endDate ? filters.date : `${filters.date}—${filters.endDate}`}
            {filters.account &&
              ` · 账号 ${filters.account === '__unassigned__' ? '未识别' : filters.account}`}
            {(filters.fromTime || filters.toTime) &&
              ` · ${filters.fromTime || '00:00:00'}—${filters.toTime || '23:59:59'}`}
            {filters.keyword && ` · 关键词：${filters.keyword}`}
          </div>
        )}
        <div className="logs-reader-toolbar flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2">
          <div className="logs-reader-heading">
            <ScrollText className="h-4 w-4" />
            <h2>日志原文</h2>
            <span>按文件顺序 · 长行分段</span>
            <label className="inline-flex min-h-8 items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={wrapLines}
                onChange={event => setWrapLines(event.target.checked)}
              />
              自动换行
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-secondary inline-flex min-h-11 items-center gap-1 sm:min-h-0"
              aria-label={readingExpanded ? '退出专注' : '专注阅读'}
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
              <span className="logs-action-long">{readingExpanded ? '退出专注' : '专注阅读'}</span>
              <span className="logs-action-short">{readingExpanded ? '退出' : '专注'}</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary inline-flex items-center gap-1"
              aria-label="复制选中日志"
              disabled={!selected}
              onClick={() => copy(selected.message)}
            >
              <Copy className="h-4 w-4" />
              <span className="logs-action-long">复制选中</span>
              <span className="logs-action-short">复制</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              aria-label="详情与上下文"
              disabled={!selected}
              onClick={event => {
                contextTriggerRef.current = event.currentTarget;
                setScope(selected.accountNumber ? 'account' : 'instance');
                setDrawerOpen(true);
              }}
            >
              <ScrollText className="h-4 w-4" />
              <span className="logs-action-long">详情与上下文</span>
              <span className="logs-action-short">上下文</span>
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
        </div>
        <div className="logs-selection-note flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-1 border-b border-gray-100 px-3 py-1 text-xs text-gray-500">
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
        <MonitorLogContextDrawer
          selected={selected}
          scope={scope}
          onScopeChange={setScope}
          wrapLines={wrapLines}
          onWrapChange={setWrapLines}
          onCopy={copy}
          notice={notice}
          highlighted={highlighted}
          onClose={() => setDrawerOpen(false)}
          dialogRef={dialogRef}
        />
      )}
    </section>
  );
}
