import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  Lock,
  RotateCcw,
  Unlock as OpenLock, // taste-skill-ignore: Lucide 图标名。
  X,
} from 'lucide-react';
import {
  applePurchaseInventoryApi as api,
  subscribeApplePurchaseInventory,
} from '../api/applePurchaseInventoryApi';
import { useAuth } from '../contexts/AuthContext';
import {
  FILTERS,
  RANGE_PRESETS,
  availabilityParams,
  buildOptions,
  defaultRange,
  formatDate,
  formatFamily,
  formatStorage,
  formatTime,
  formatTimestamp,
  getRangeBounds,
  getTrendBounds,
} from './applePurchaseAvailabilityFilters';
import ApplePurchaseAvailabilityTrend from './ApplePurchaseAvailabilityTrend';
import './applePurchaseAvailability.css';

const PAGE_SIZES = [20, 50, 100, 200];
const RESULT_TABS = [
  ['records', '有货明细'],
  ['trend', '趋势统计'],
];
const LOCK_STORAGE_KEY = 'applePurchaseAvailability.locks.v1';
const PAGE_TITLE = 'ApplePurchase 有货记录';
const DATE_FIELD = { key: 'range', label: '检测时间' };
const INITIAL_SELECTIONS = Object.fromEntries(FILTERS.map(({ key }) => [key, []]));

function readLocks(storageKey) {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey)) || {};
    const locks = {};
    for (const { key } of FILTERS) {
      if (Array.isArray(stored[key])) {
        locks[key] = [...new Set(stored[key])]
          .filter(value => typeof value === 'string' && value.trim() && value.length <= 128)
          .slice(0, 100);
      }
    }
    const range = stored.range;
    if (RANGE_PRESETS.some(([key]) => key === range?.preset)) {
      locks.range = { ...defaultRange(), preset: range.preset };
    } else if (
      range?.preset === 'custom' &&
      [range.from, range.to].every(
        value =>
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          Number.isFinite(Date.parse(value)) &&
          formatDate(value) === value
      ) &&
      range.from <= range.to
    ) {
      locks.range = { preset: 'custom', from: range.from, to: range.to };
    }
    return locks;
  } catch {
    return {};
  }
}

function getRangeLabel(range) {
  if (range.preset === 'custom') {
    return range.from === range.to ? range.from : `${range.from} 至 ${range.to}`;
  }
  return RANGE_PRESETS.find(([key]) => key === range.preset)[1];
}

function getSelectionLabel(field, values, options) {
  if (!values.length) return field.all;
  const first = options.find(option => option.value === values[0])?.label || '历史选项';
  return values.length === 1 ? first : `${first} +${values.length - 1}`;
}

function useAvailabilityRequest(request, query, refresh = 0) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (query === null) return undefined;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await request(query, controller.signal);
        if (!controller.signal.aborted) setResult({ query, refresh, data, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ query, refresh, data: null, error });
      }
    };
    load();
    return () => controller.abort();
  }, [query, refresh, request]);
  const sameQuery = query !== null && result?.query === query;
  const loading = query !== null && (!sameQuery || result.refresh !== refresh);
  return {
    data: sameQuery ? result.data : null,
    error: sameQuery && !loading ? result.error : null,
    loading,
  };
}

function FilterControl({ field, value, options, locked, onEdit, onLock }) {
  const label =
    field.key === 'range' ? getRangeLabel(value) : getSelectionLabel(field, value, options);
  const LockIcon = locked ? Lock : OpenLock;
  return (
    <div className="apav-field">
      <span className="apav-label">{field.label}</span>
      <div className="apav-control" data-locked={locked}>
        <button
          type="button"
          className="btn btn-secondary apav-select"
          onClick={onEdit}
          aria-label={`选择${field.label}，当前${label}`}
          aria-haspopup="dialog"
          disabled={locked}
          title={label}
        >
          {field.key === 'range' && <CalendarDays size={16} aria-hidden="true" />}
          <span>{label}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn btn-secondary apav-lock"
          onClick={onLock}
          aria-pressed={locked}
          aria-label={`${locked ? '解锁' : '锁定'}${field.label}`}
          title={`${locked ? '解锁' : '锁定'}${field.label}`}
        >
          <LockIcon size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function AvailabilityDialog({ title, children, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="apav-dialog"
      aria-labelledby="apav-dialog-title"
      onClose={onClose}
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.close();
        }
      }}
    >
      <header className="apav-dialog-head">
        <h2 id="apav-dialog-title">{title}</h2>
        <form method="dialog">
          <button className="btn btn-secondary apav-icon" aria-label="关闭">
            <X size={18} aria-hidden="true" />
          </button>
        </form>
      </header>
      {children}
    </dialog>
  );
}

function ChoiceEditor({ field, options, values, onChange, onClose }) {
  const [search, setSearch] = useState('');
  const matching = options.filter(option =>
    option.label.toLowerCase().includes(search.trim().toLowerCase())
  );
  return (
    <AvailabilityDialog title={`选择${field.label}`} onClose={onClose}>
      <div className="apav-dialog-content">
        <label className="apav-search">
          <span>搜索{field.label}</span>
          <input
            className="input"
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </label>
        <div className="apav-choice-summary">
          <span>{values.length ? `已选 ${values.length} 项` : field.all}</span>
          <button
            type="button"
            className="btn apav-text-button"
            disabled={!values.length}
            onClick={() => onChange([])}
          >
            清除选择
          </button>
        </div>
        <div className="apav-choices" role="group" aria-label={field.label}>
          {matching.map(({ value, label }) => (
            <label className="apav-choice" key={value}>
              <input
                type="checkbox"
                checked={values.includes(value)}
                onChange={event =>
                  onChange(
                    event.target.checked
                      ? [...values, value]
                      : values.filter(item => item !== value)
                  )
                }
              />
              {label}
            </label>
          ))}
          {!matching.length && <p className="apav-muted apav-no-options">没有匹配的选项</p>}
        </div>
      </div>
      <form method="dialog" className="apav-dialog-foot">
        <button className="btn btn-primary apav-primary">完成</button>
      </form>
    </AvailabilityDialog>
  );
}

function RangeEditor({ range, onChange, onClose }) {
  const [custom, setCustom] = useState({ from: range.from, to: range.to });
  const apply = (event, nextRange) => {
    event.preventDefault();
    onChange(nextRange);
    event.currentTarget.closest('dialog').close();
  };
  return (
    <AvailabilityDialog title="选择检测时间" onClose={onClose}>
      <div className="apav-dialog-content">
        <div className="apav-presets">
          {RANGE_PRESETS.map(([preset, label]) => (
            <button
              type="button"
              key={preset}
              className="btn btn-secondary"
              aria-pressed={range.preset === preset}
              onClick={event => apply(event, { ...defaultRange(), preset })}
            >
              {label}
            </button>
          ))}
        </div>
        <form onSubmit={event => apply(event, { ...custom, preset: 'custom' })}>
          <h3>自定义日期（北京时间）</h3>
          <div className="apav-date-inputs">
            <label>
              开始日期
              <input
                className="input"
                type="date"
                required
                max={custom.to || undefined}
                value={custom.from}
                onChange={event => setCustom({ ...custom, from: event.target.value })}
              />
            </label>
            <label>
              结束日期
              <input
                className="input"
                type="date"
                required
                min={custom.from || undefined}
                value={custom.to}
                onChange={event => setCustom({ ...custom, to: event.target.value })}
              />
            </label>
          </div>
          <div className="apav-dialog-foot apav-range-foot">
            <button className="btn btn-primary apav-primary">应用日期</button>
          </div>
        </form>
      </div>
    </AvailabilityDialog>
  );
}

function ObservationDetail({ row, onClose }) {
  const details = [
    ['检测时间', `${formatDate(row.detectedAt)} ${formatTime(row.detectedAt)}`],
    ['PP 入库时间', `${formatDate(row.ingestedAt)} ${formatTime(row.ingestedAt)}`],
    ['城市与门店', `${row.city} · ${row.store}`],
    ['商品规格', row.productName],
    ['料号', row.partNumber],
    ['来源终端', row.terminal],
    ['记录 ID', row.id],
  ];
  return (
    <AvailabilityDialog title="有货记录详情" onClose={onClose}>
      <p className="apav-detail-note">时间均为北京时间。</p>
      <dl className="apav-detail">
        {details.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </AvailabilityDialog>
  );
}

/** 通过受权独立链接查询 PP 已同步的 ApplePurchase 有货记录。 */
export default function ApplePurchaseAvailability() {
  const { user } = useAuth();
  const storageKey = `${LOCK_STORAGE_KEY}.${user.id}`;
  const [locks, setLocks] = useState(() => readLocks(storageKey));
  const [range, setRange] = useState(() => locks.range ?? defaultRange());
  const [selections, setSelections] = useState(() =>
    Object.fromEntries(FILTERS.map(({ key }) => [key, locks[key] ?? INITIAL_SELECTIONS[key]]))
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const mobileToggle = useRef(null);
  const [editor, setEditor] = useState(null);
  const [detail, setDetail] = useState(null);
  const [cursors, setCursors] = useState([]);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [eventVersion, setEventVersion] = useState('0');
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [resultTab, setResultTab] = useState('records');
  const [trendInterval, setTrendInterval] = useState('hour');
  const [storageError, setStorageError] = useState(false);
  const catalogQuery = useAvailabilityRequest(api.availabilityOptions, '', refresh);
  const catalog = catalogQuery.data;
  const options = useMemo(() => buildOptions(catalog), [catalog]);
  const bounds = getRangeBounds(range, now);
  const trendBounds = getTrendBounds(bounds, catalog);
  const page = cursors.length;
  const recordsKey =
    catalog && resultTab === 'records'
      ? availabilityParams(catalog.snapshot, bounds, selections, {
          limit: pageSize,
          ...(page ? { cursor: cursors.at(-1) } : {}),
        })
      : null;
  const trendKey =
    catalog && trendBounds && resultTab === 'trend'
      ? availabilityParams(catalog.snapshot, trendBounds, selections, { interval: trendInterval })
      : null;
  const recordsQuery = useAvailabilityRequest(api.availabilityRecords, recordsKey, refresh);
  const trendQuery = useAvailabilityRequest(api.availabilityTrend, trendKey, refresh);
  const records = recordsQuery.data;
  const terminalNames = new Map(options.terminalId.map(({ value, label }) => [value, label]));
  const visibleRows = (records?.items ?? []).map(row => ({
    ...row,
    model: formatFamily(row.family),
    capacity: formatStorage(row.storage),
    terminal: terminalNames.get(row.terminalId) || '—',
  }));
  const newRecords = catalog && BigInt(eventVersion) > BigInt(catalog.snapshot);
  const lockedCount = Object.keys(locks).length;
  const activeFields = FILTERS.filter(({ key }) => selections[key].length);
  const filterSummary = activeFields
    .map(field => getSelectionLabel(field, selections[field.key], options[field.key]))
    .join(' · ');
  const canReset =
    (!locks.range && range.preset !== '24h') || activeFields.some(({ key }) => !(key in locks));

  useEffect(() => {
    const previous = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(
    () =>
      subscribeApplePurchaseInventory(version => {
        if (/^\d+$/.test(version.observations)) setEventVersion(version.observations);
      }),
    []
  );

  function refreshResults() {
    setCursors([]);
    setNow(Date.now());
    setRefresh(previous => previous + 1);
  }

  function toggleLock(key) {
    const next = { ...locks };
    if (key in next) delete next[key];
    else next[key] = key === 'range' ? range : selections[key];
    setLocks(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }

  function resetFilters() {
    setRange(locks.range ?? defaultRange(now));
    setSelections(
      Object.fromEntries(FILTERS.map(({ key }) => [key, locks[key] ?? INITIAL_SELECTIONS[key]]))
    );
    setCursors([]);
  }

  function handleTabKey(event) {
    const index = RESULT_TABS.findIndex(([key]) => key === resultTab);
    const nextIndex = {
      ArrowLeft: (index - 1 + RESULT_TABS.length) % RESULT_TABS.length,
      ArrowRight: (index + 1) % RESULT_TABS.length,
      Home: 0,
      End: RESULT_TABS.length - 1,
    }[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    setResultTab(RESULT_TABS[nextIndex][0]);
    event.currentTarget.querySelectorAll('[role="tab"]')[nextIndex].focus();
  }

  function renderControl(field) {
    return (
      <FilterControl
        key={field.key}
        field={field}
        value={field.key === 'range' ? range : selections[field.key]}
        options={options[field.key]}
        locked={field.key in locks}
        onEdit={() => setEditor(field)}
        onLock={() => toggleLock(field.key)}
      />
    );
  }

  const editorKey = editor?.key;
  const selectedValues = selections[editorKey] ?? [];
  const editorOptions = options[editorKey] ?? [];
  const availableOptions = [
    ...editorOptions.filter(
      option =>
        editorKey !== 'storeId' ||
        !selections.city.length ||
        option.cities.some(city => selections.city.includes(city)) ||
        selectedValues.includes(option.value)
    ),
    ...selectedValues
      .filter(value => !editorOptions.some(option => option.value === value))
      .map(value => ({ value, label: '历史选项' })),
  ];
  const recordLoading = catalogQuery.loading || recordsQuery.loading;
  const recordError = catalogQuery.error || recordsQuery.error;

  return (
    <main className="apav-page">
      <div className="apav-shell">
        <header className="apav-header">
          <div className="apav-identity">
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
              <path
                d="M4 7h18M4 13h18M4 19h12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <circle
                cx="17"
                cy="13"
                r="3"
                fill="var(--apav-ground)"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
            <h1>{PAGE_TITLE}</h1>
          </div>
          <p>查询 Apple 门店曾检测到有货的机型、颜色和容量。</p>
        </header>
        <div className="apav-snapshot">
          <span>
            <strong>PP 同步记录</strong>
            {catalog?.firstDetectedAt && (
              <>
                {' '}
                · {formatDate(catalog.firstDetectedAt)} 至 {formatDate(catalog.lastDetectedAt)}
              </>
            )}
          </span>
          <div className="apav-sync-status">
            <span>最近检测 {formatTimestamp(catalog?.lastDetectedAt)}</span>
            <span>最后同步 {formatTimestamp(catalog?.lastSyncAt)}</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={refreshResults}
              disabled={catalogQuery.loading}
            >
              {newRecords ? '有新记录，刷新' : '刷新'}
            </button>
          </div>
        </div>

        <section className="apav-filters" aria-labelledby="apav-filter-title">
          <div className="apav-filter-top">
            <div className="apav-filter-head">
              <h2 id="apav-filter-title">筛选记录</h2>
              <p>
                {lockedCount
                  ? `已锁定 ${lockedCount} 项，重置与下次打开时保留。`
                  : '同一项可多选，锁定后保留当前选择。'}
              </p>
            </div>
            <div className="apav-date-row">
              {renderControl(DATE_FIELD)}
              <button
                ref={mobileToggle}
                type="button"
                className="btn btn-secondary apav-mobile-toggle"
                aria-controls="apav-dimensions"
                aria-expanded={filterOpen}
                onClick={() => setFilterOpen(!filterOpen)}
              >
                <ListFilter size={16} aria-hidden="true" />
                筛选{activeFields.length ? ` (${activeFields.length})` : ''}
              </button>
            </div>
            <button
              type="button"
              className="btn btn-secondary apav-reset"
              onClick={resetFilters}
              disabled={!canReset}
            >
              <RotateCcw size={15} aria-hidden="true" />
              重置未锁定
            </button>
          </div>
          {filterSummary && !filterOpen && <p className="apav-mobile-summary">{filterSummary}</p>}
          <div id="apav-dimensions" className="apav-dimensions" data-open={filterOpen}>
            {FILTERS.map(renderControl)}
            <button
              type="button"
              className="btn btn-primary apav-primary apav-mobile-done"
              onClick={() => {
                mobileToggle.current?.focus();
                setFilterOpen(false);
              }}
            >
              查看结果
            </button>
          </div>
          {storageError && (
            <p role="status" className="apav-muted">
              浏览器无法保存锁定，当前页面仍可使用。
            </p>
          )}
        </section>

        <section className="apav-results" aria-label="有货记录结果">
          <div
            className="apav-result-tabs"
            role="tablist"
            aria-label="结果视图"
            onKeyDown={handleTabKey}
          >
            {RESULT_TABS.map(([key, label]) => (
              <button
                key={key}
                id={`apav-tab-${key}`}
                type="button"
                role="tab"
                aria-selected={resultTab === key}
                aria-controls={`apav-panel-${key}`}
                tabIndex={resultTab === key ? 0 : -1}
                className="btn"
                onClick={() => setResultTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            id="apav-panel-records"
            role="tabpanel"
            aria-labelledby="apav-tab-records"
            hidden={resultTab !== 'records'}
          >
            <div className="apav-results-head">
              <div className="apav-result-label">
                <span aria-live="polite">
                  {records ? `${records.total.toLocaleString('zh-CN')} 条` : '—'}
                </span>
                <p>按检测时间倒序 · 北京时间</p>
              </div>
              <label className="apav-page-size">
                <span>每页条数</span>
                <select
                  className="input"
                  value={pageSize}
                  onChange={event => {
                    setPageSize(Number(event.target.value));
                    setCursors([]);
                  }}
                >
                  {PAGE_SIZES.map(size => (
                    <option key={size} value={size}>
                      {size} 条
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <table className="apav-table">
              <thead>
                <tr>
                  <th scope="col" className="apav-time" aria-sort="descending">
                    检测时间 <ArrowDown size={13} aria-hidden="true" />
                  </th>
                  <th scope="col">城市／门店</th>
                  <th scope="col">
                    机型<span className="apav-compact">／规格</span>
                  </th>
                  <th scope="col" className="apav-wide">
                    颜色
                  </th>
                  <th scope="col" className="apav-wide">
                    容量
                  </th>
                  <th scope="col" className="apav-wide">
                    料号
                  </th>
                  <th scope="col" className="apav-wide">
                    来源终端
                  </th>
                  <th scope="col" className="apav-row-action">
                    <span className="sr-only">详情</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(row => (
                  <tr key={row.sequence}>
                    <td className="apav-time">
                      <time dateTime={new Date(row.detectedAt).toISOString()}>
                        <strong>{formatTime(row.detectedAt)}</strong>
                        <small>{formatDate(row.detectedAt)}</small>
                      </time>
                    </td>
                    <td>
                      <strong>{row.store}</strong>
                      <small>{row.city || '—'}</small>
                    </td>
                    <td>
                      <strong className="apav-full-model">{row.model}</strong>
                      <strong className="apav-short-model">
                        {row.model.replace(/^iPhone 18 /, '18 ')}
                      </strong>
                      <small className="apav-compact">
                        {row.color || '—'} · {row.capacity}
                      </small>
                    </td>
                    <td className="apav-wide">{row.color || '—'}</td>
                    <td className="apav-wide">{row.capacity}</td>
                    <td className="apav-wide apav-muted">{row.partNumber}</td>
                    <td className="apav-wide apav-muted">{row.terminal}</td>
                    <td className="apav-row-action">
                      <button
                        type="button"
                        className="btn apav-icon"
                        aria-label={`查看 ${row.store} ${row.model} ${formatTime(row.detectedAt)} 详情`}
                        aria-haspopup="dialog"
                        onClick={() => setDetail(row)}
                      >
                        <ChevronRight size={17} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {recordLoading && !records && (
              <p className="apav-empty" role="status">
                正在加载有货记录…
              </p>
            )}
            {recordError && (
              <p className="apav-empty" role="alert">
                {recordError.message}{' '}
                <button type="button" className="btn btn-secondary" onClick={refreshResults}>
                  重试
                </button>
              </p>
            )}
            {!recordLoading && records?.total === 0 && (
              <p className="apav-empty">当前筛选范围内暂无有货记录，可调整日期或筛选条件。</p>
            )}
            <footer className="apav-pagination">
              <p>
                {records?.total
                  ? `第 ${page * pageSize + 1}–${page * pageSize + visibleRows.length} 条，共 ${records.total.toLocaleString('zh-CN')} 条`
                  : records
                    ? '共 0 条记录'
                    : '—'}
              </p>
              <div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setCursors(previous => previous.slice(0, -1))}
                  disabled={page === 0 || recordLoading}
                >
                  <ChevronLeft size={15} aria-hidden="true" />
                  上一页
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setCursors(previous => [...previous, records.nextCursor])}
                  disabled={!records?.nextCursor || recordLoading}
                >
                  下一页
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </div>
            </footer>
          </div>
          <div
            id="apav-panel-trend"
            role="tabpanel"
            aria-labelledby="apav-tab-trend"
            hidden={resultTab !== 'trend'}
          >
            {resultTab === 'trend' && (
              <ApplePurchaseAvailabilityTrend
                bounds={trendBounds}
                rows={trendQuery.data?.points}
                error={catalogQuery.error || trendQuery.error}
                loading={catalogQuery.loading || trendQuery.loading}
                families={catalog?.families ?? []}
                interval={trendInterval}
                onIntervalChange={setTrendInterval}
              />
            )}
          </div>
        </section>
        <p className="apav-footnote">每行是一条有货观察，同一门店和料号可在不同时间重复出现。</p>
      </div>
      {editor?.key === 'range' && (
        <RangeEditor
          range={range}
          onChange={next => {
            setRange(next);
            setCursors([]);
          }}
          onClose={() => setEditor(null)}
        />
      )}
      {editor && editor.key !== 'range' && (
        <ChoiceEditor
          field={editor}
          options={availableOptions}
          values={selections[editor.key]}
          onChange={next => {
            setSelections(previous => ({ ...previous, [editor.key]: next }));
            setCursors([]);
          }}
          onClose={() => setEditor(null)}
        />
      )}
      {detail && <ObservationDetail row={detail} onClose={() => setDetail(null)} />}
    </main>
  );
}
