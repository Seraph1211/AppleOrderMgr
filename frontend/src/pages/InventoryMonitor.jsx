import ResponsiveSelect from '../components/responsiveSelect';
import { STATUS, timeText, failureText } from '../components/inventory/inventoryPresentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import InventoryScope from '../components/inventory/InventoryScope';
import {
  PackageSearch,
  RefreshCw,
  Copy,
  Download,
  Bell,
  Activity,
  ArrowUpRight,
  MapPin,
  History,
  BarChart3,
  Settings2,
} from 'lucide-react';
import '../components/inventory/inventory.css';
import { inventoryApi as api } from '../api/inventoryApi';
import {
  InventoryFilters,
  FilterSection,
  CompactRecord,
  RecordFields,
  MultiSelect,
  Pager,
  Status,
  Table,
} from '../components/inventory/InventoryCommon';
import InventoryAnalysisView from '../components/inventory/InventoryAnalysisView';
import InventoryCoverageDialog from '../components/inventory/InventoryCoverageDialog';

const TABS = {
  latest: '全国库存',
  manage: '监控管理',
  history: '历史记录',
  analysis: '统计分析',
  settings: '通知与健康',
};
const EMPTY_CATALOG = { products: [], stores: [] };
const serialize = values =>
  Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => !Array.isArray(value) || value.length)
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value])
  );
const localDate = date => new Date(date.getTime() + 28800000).toISOString().slice(0, 16);
/** 库存分组页面内的视图；配置与手动采集仅管理员可用。 */
function InventoryView({ view = 'latest', mode = 'read' }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const admin = isAdmin();
  const tab = view;
  const initial = location.state || {};
  const [scope, setScope] = useState(null);
  const [roundId, setRoundId] = useState(null);
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [filters, setFilters] = useState(initial.filters || {});
  const [applied, setApplied] = useState(initial.filters || {});
  const [page, setPage] = useState(1);
  const [onlyInStock, setOnlyInStock] = useState(false);
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState([]);
  const [catalogKind, setCatalogKind] = useState('products');
  const [catalogSelected, setCatalogSelected] = useState([]);
  const [webhook, setWebhook] = useState('');
  const [metric, setMetric] = useState(initial.metric || 'arrivals');
  const [source, setSource] = useState(initial.source || 'all');
  const [bucketMinutes, setBucketMinutes] = useState(60);
  const [hour, setHour] = useState(initial.hour ?? '');
  const [from, setFrom] = useState(
    () => initial.from || `${localDate(new Date()).slice(0, 10)}T00:00`
  );
  const [to, setTo] = useState(() => initial.to || localDate(new Date(Date.now() + 60000)));
  const sequence = useRef(0);
  const mounted = useRef(true);
  const switchTab = (name, overrides = {}) => {
    navigate(
      `${['manage', 'settings'].includes(name) ? '/inventory-monitor/manage' : '/inventory-monitor'}?tab=${name}`,
      {
        state: {
          filters: applied,
          metric: name === 'analysis' && metric === 'all' ? 'arrivals' : metric,
          source,
          from,
          to,
          hour,
          ...overrides,
        },
      }
    );
  };
  const historyParams = useCallback(
    () => ({
      ...serialize(applied),
      from: from ? new Date(`${from}:00+08:00`).toISOString() : undefined,
      to: to ? new Date(`${to}:00+08:00`).toISOString() : undefined,
      metric,
      source,
      ...(hour !== '' ? { hour } : {}),
    }),
    [applied, from, to, metric, source, hour]
  );
  const load = useCallback(
    async (quiet = false) => {
      const id = ++sequence.current;
      if (!quiet) setLoading(true);
      try {
        const path = {
          latest: 'latest',
          manage: 'rounds',
          history: 'history',
          analysis: 'analysis',
          settings: 'deliveries',
        }[tab];
        const query = ['history', 'analysis'].includes(tab)
          ? { ...historyParams(), bucketMinutes }
          : { ...serialize(applied), onlyInStock };
        const [result, overview, h] = await Promise.all([
          api.get(path, { ...query, page, pageSize: 50 }),
          api.get('scope'),
          admin ? api.get('health') : Promise.resolve(null),
        ]);
        if (id !== sequence.current || !mounted.current) return;
        setData(result.data);
        setScope(overview.data);
        setHealth(h?.data || null);
        setError('');
        if (tab === 'latest')
          setSelected(previous =>
            previous.filter(key => result.data.items.some(row => row.id === key))
          );
      } catch (failure) {
        if (id === sequence.current && mounted.current) setError(failure.message);
      } finally {
        if (id === sequence.current && mounted.current) setLoading(false);
      }
    },
    [tab, applied, onlyInStock, page, bucketMinutes, historyParams, admin]
  );
  useEffect(() => {
    mounted.current = true;
    const initial = async () => {
      try {
        const [c, s] = await Promise.all([
          api.get('catalog'),
          admin ? api.get('settings') : Promise.resolve(null),
        ]);
        if (mounted.current) {
          setCatalog(c.data);
          setSettings(s?.data || null);
          setDraft(s?.data.config || null);
        }
      } catch (failure) {
        if (mounted.current) setError(failure.message);
      }
    };
    initial();
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [admin]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (tab !== 'latest') return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) load(true);
    }, 10000);
    return () => clearInterval(timer);
  }, [tab, load]);
  const act = async (work, message) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      if (mounted.current) {
        setNotice(message);
        await load(true);
      }
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      const result = await api.put('settings', {
        version: settings.version,
        config: draft,
        ...(webhook ? { webhook } : {}),
      });
      setSettings(result.data);
      setDraft(result.data.config);
      setWebhook('');
    }, '设置已保存');
  const update = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
  const updateCatalog = enabled =>
    act(
      async () => {
        await api.put('catalog', { kind: catalogKind, ids: catalogSelected, enabled });
        const result = await api.get('catalog');
        setCatalog(result.data);
        setCatalogSelected([]);
      },
      enabled ? '所选项目已启用' : '所选项目已停用'
    );
  const copy = () =>
    act(async () => {
      const rows = data.items.filter(r => selected.includes(r.id));
      if (!rows.length) throw new Error('请先勾选要复制的行');
      await navigator.clipboard.writeText(
        rows
          .map(
            r =>
              `${r.city} · Apple ${r.storeName}\t${r.model} ${r.capacity} ${r.color}\t${STATUS[r.displayStatus]}\t${r.quote || ''}\t${timeText(r.observedAt)}`
          )
          .join('\n')
      );
    }, '选中库存已复制');
  const exportHistory = () =>
    act(async () => {
      const text = await api.export(historyParams());
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = '库存历史.csv';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, '已按当前筛选导出');
  const drill = (kind, key) => {
    let next = { ...applied };
    setHour('');
    if (kind === 'latest') {
      next = { skus: [key.sku], stores: [key.storeCode] };
      setMetric('all');
    }
    if (kind === 'cities') next.cities = [key];
    if (kind === 'stores') {
      const store = catalog.stores.find(s => `${s.city} · ${s.storeName}` === key);
      if (store) next.stores = [store.storeCode];
    }
    if (kind === 'configurations') {
      const [model, capacity, color] = key.split(' · ');
      next = { ...next, models: [model], capacities: [capacity], colors: [color] };
    }
    if (kind === 'hours') setHour(key);
    if (kind === 'heatmap') {
      setFrom(localDate(new Date(+key)));
      setTo(localDate(new Date(+key + bucketMinutes * 60000)));
    }
    setFilters(next);
    setApplied(next);
    switchTab('history', {
      filters: next,
      metric: kind === 'latest' ? 'all' : metric,
      hour: kind === 'hours' ? key : '',
      ...(kind === 'heatmap'
        ? { from: localDate(new Date(+key)), to: localDate(new Date(+key + bucketMinutes * 60000)) }
        : {}),
    });
  };
  const apply = () => {
    setApplied(filters);
    setPage(1);
    setSelected([]);
    setHour('');
  };
  const tableRows = data?.items || [];
  const currentCatalog = catalog[catalogKind];
  return (
    <div className="inventory-page min-w-0">
      {roundId && <InventoryCoverageDialog id={roundId} onClose={() => setRoundId(null)} />}
      <header className="inventory-header">
        <div className="flex items-center gap-3 min-w-0">
          <div className="inventory-brand-icon">
            <PackageSearch className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-semibold tracking-tight text-gray-900">
              {mode === 'admin' ? '监控管理' : '库存查询'}
            </h1>
            <p className="text-xs sm:text-sm text-gray-500 mt-1">
              大陆 Apple 直营店{' '}
              <span className="hidden sm:inline">· iPhone 18 Pro 系列 · 北京时间</span>
            </p>
          </div>
        </div>
        <button
          className="btn btn-secondary inventory-refresh inline-flex items-center justify-center gap-2"
          disabled={loading || busy}
          onClick={() => load()}
          aria-label="刷新页面"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">刷新页面</span>
        </button>
      </header>
      <nav
        className="inventory-nav"
        aria-label="库存视图"
        style={{ '--inventory-tab-count': mode === 'admin' ? 2 : 3 }}
      >
        {(mode === 'admin' ? ['manage', 'settings'] : ['latest', 'history', 'analysis']).map(
          key => {
            const Icon = {
              latest: MapPin,
              history: History,
              analysis: BarChart3,
              manage: Settings2,
              settings: Bell,
            }[key];
            return (
              <button
                key={key}
                className={`inventory-tab ${tab === key ? 'inventory-tab-active' : ''}`}
                aria-current={tab === key ? 'page' : undefined}
                onClick={() => switchTab(key)}
              >
                <Icon className="w-4 h-4" />
                <span>{TABS[key]}</span>
              </button>
            );
          }
        )}
      </nav>
      {admin && (
        <div className="inventory-state-strip">
          <button
            onClick={() => switchTab('manage')}
            aria-label="前往监控管理设置采集"
            className="inventory-state-link"
          >
            <span
              className={`inventory-status-dot ${settings?.config.enabled ? 'text-green-600' : 'text-gray-400'}`}
            />
            采集{settings?.config.enabled ? '已开启' : '已关闭'}
            <ArrowUpRight className="w-3 h-3" />
          </button>
          <button
            onClick={() => switchTab('settings')}
            aria-label="前往通知设置"
            className="inventory-state-link"
          >
            <span
              className={`inventory-status-dot ${settings?.config.notificationsEnabled ? 'text-green-600' : 'text-gray-400'}`}
            />
            通知{settings?.config.notificationsEnabled ? '已开启' : '已关闭'}
            <ArrowUpRight className="w-3 h-3" />
          </button>
          <span className="hidden lg:block ml-auto text-xs text-gray-400">
            最新快照每 10 秒自动更新 · 所有时间为北京时间
          </span>
        </div>
      )}
      {['latest', 'manage'].includes(tab) && <InventoryScope scope={scope} />}
      {tab === 'latest' && (
        <div className="inventory-overview" aria-label="当前筛选库存概览">
          {[
            ['筛选组合', data?.summary?.combinations, 'text-gray-900'],
            ['新鲜结果', data?.summary?.fresh, 'text-primary'],
            ['有货门店', data?.summary?.currentStores, 'text-green-700'],
          ].map(([label, value, color]) => (
            <div key={label}>
              <span className="text-xs sm:text-sm text-gray-500">{label}</span>
              <strong
                className={`block text-xl sm:text-2xl font-semibold tabular-nums mt-1 ${color}`}
              >
                {value ?? '—'}
              </strong>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div
          className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex flex-wrap gap-2 justify-between"
          role="alert"
        >
          <span>{error}</span>
          <button className="underline" onClick={() => load()}>
            重试加载
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="bg-blue-50 rounded-lg p-3 text-sm text-primary">
          {notice}
        </p>
      )}
      {health && (health.paused || health.state === 'degraded' || !settings?.config.enabled) && (
        <p className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          {!settings?.config.enabled
            ? '全局监控已关闭，页面保留上次结果。'
            : `采集保护：${STATUS[health.state] || health.state}；${health.reason ? failureText(health.reason) : '等待冷却到期'}`}{' '}
          {health.cooldownUntil ? `截止 ${timeText(health.cooldownUntil)}` : ''}
        </p>
      )}
      {['latest', 'history', 'analysis'].includes(tab) && (
        <InventoryFilters
          catalog={catalog}
          filters={filters}
          applied={applied}
          onChange={setFilters}
          onApply={apply}
          onReset={() => {
            setFilters({});
            setApplied({});
            setPage(1);
            setSelected([]);
            setHour('');
          }}
        />
      )}
      {['history', 'analysis'].includes(tab) && (
        <FilterSection
          title="时间与统计口径"
          summary={`${from.replace('T', ' ')} — ${to.replace('T', ' ')} · 北京时间`}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="text-sm text-gray-600">
              开始（北京时间）
              <input
                className="input w-full mt-1"
                type="datetime-local"
                value={from}
                onChange={e => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label className="text-sm text-gray-600">
              结束（北京时间）
              <input
                className="input w-full mt-1"
                type="datetime-local"
                value={to}
                onChange={e => {
                  setTo(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label className="text-sm text-gray-600">
              统计口径
              <ResponsiveSelect
                className="input w-full mt-1"
                value={metric}
                onChange={e => {
                  setMetric(e.target.value);
                  setPage(1);
                }}
              >
                {Object.entries({
                  arrivals: '到货变化事件',
                  detections: '有货检测记录',
                  first: '首次观察',
                  recovery: '恢复观察',
                  ...(tab === 'history' ? { all: '所有有效检测' } : {}),
                }).map(([v, label]) => (
                  <option value={v} key={v}>
                    {label}
                  </option>
                ))}
              </ResponsiveSelect>
            </label>
            <label className="text-sm text-gray-600">
              采集来源
              <ResponsiveSelect
                className="input w-full mt-1"
                value={source}
                onChange={e => {
                  setSource(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">全部</option>
                <option value="auto">自动</option>
                <option value="manual">手动</option>
              </ResponsiveSelect>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
              onClick={() => {
                setFrom(localDate(new Date(Date.now() - 3600000)));
                setTo(localDate(new Date(Date.now() + 60000)));
                setHour('');
              }}
            >
              最近 1 小时
            </button>
            <button
              className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
              onClick={() => {
                setFrom(`${localDate(new Date()).slice(0, 10)}T00:00`);
                setTo(localDate(new Date(Date.now() + 60000)));
                setHour('');
              }}
            >
              今天
            </button>
            {tab === 'analysis' && (
              <label className="flex items-center gap-2 text-sm">
                热力图间隔
                <ResponsiveSelect
                  aria-label="热力图间隔"
                  className="input"
                  value={bucketMinutes}
                  onChange={e => setBucketMinutes(+e.target.value)}
                >
                  {[10, 20, 30, 60].map(v => (
                    <option key={v} value={v}>
                      {v} 分钟
                    </option>
                  ))}
                </ResponsiveSelect>
              </label>
            )}
            {hour !== '' && (
              <button
                className="btn inline-flex items-center justify-center gap-2 btn-secondary"
                onClick={() => setHour('')}
              >
                仅 {hour} 时 ×
              </button>
            )}
          </div>
        </FilterSection>
      )}
      {loading && !data && (
        <p role="status" className="py-10 text-center text-gray-500">
          正在加载库存数据…
        </p>
      )}
      {tab === 'latest' && (
        <>
          <div className="inventory-list-toolbar">
            <div>
              <h2 className="font-semibold text-gray-900">全国库存</h2>
              <p className="text-xs text-gray-500 mt-1">官网采集时间见各行，缓存刷新不触发采集</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-2 text-sm min-h-[44px]">
                <input
                  type="checkbox"
                  checked={onlyInStock}
                  onChange={e => {
                    setOnlyInStock(e.target.checked);
                    setPage(1);
                  }}
                />
                仅看有货
              </label>
              <button
                className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
                disabled={busy || !selected.length}
                onClick={copy}
              >
                <Copy className="w-4 h-4" />
                复制选中 ({selected.length})
              </button>
              {admin && (
                <button
                  className="btn inline-flex items-center justify-center gap-2 btn-primary min-h-[44px]"
                  disabled={busy || !settings?.config.enabled}
                  onClick={() =>
                    act(async () => {
                      await api.post('refresh', serialize(applied));
                    }, '当前筛选已进入统一查询队列，保护和预算仍生效')
                  }
                >
                  <RefreshCw className="w-4 h-4" />
                  检查当前筛选
                </button>
              )}
            </div>
          </div>
          <Table
            headers={[
              <input
                key="all"
                type="checkbox"
                aria-label="全选本页库存"
                checked={tableRows.length > 0 && selected.length === tableRows.length}
                onChange={e => setSelected(e.target.checked ? tableRows.map(r => r.id) : [])}
              />,
              '商品配置',
              '城市 / 门店',
              '当前状态',
              '官网提示 / 上次有效结果',
              '最后成功 / 最近尝试',
              '历史',
            ]}
            empty={!tableRows.length}
            label="全国库存列表"
            mobileHeader={
              <label className="flex items-center gap-2 min-h-[44px]">
                <input
                  type="checkbox"
                  aria-label="全选本页库存"
                  checked={tableRows.length > 0 && selected.length === tableRows.length}
                  onChange={e => setSelected(e.target.checked ? tableRows.map(r => r.id) : [])}
                />
                全选本页<span className="ml-auto text-gray-500">已选 {selected.length} 项</span>
              </label>
            }
            mobileChildren={tableRows.map(row => (
              <CompactRecord
                key={row.id}
                title={row.model}
                subtitle={`${row.capacity} · ${row.color} / ${row.city} ${row.storeName}`}
                status={<Status value={row.displayStatus} />}
                selection={
                  <input
                    type="checkbox"
                    aria-label={`选择 ${row.sku} ${row.storeCode}`}
                    checked={selected.includes(row.id)}
                    onChange={e =>
                      setSelected(
                        e.target.checked
                          ? [...selected, row.id]
                          : selected.filter(id => id !== row.id)
                      )
                    }
                  />
                }
                meta={`最后成功：${timeText(row.observedAt)}`}
              >
                <RecordFields
                  fields={[
                    ['精确 SKU', row.sku],
                    ['官网提示', row.quote || '尚无有效提示'],
                    ['上次有效状态', STATUS[row.lastStatus]],
                    ['最近尝试', timeText(row.lastAttemptAt)],
                    ['异常原因', row.error ? failureText(row.error) : '无'],
                  ]}
                />
                <button
                  className="btn btn-secondary mt-3 w-full"
                  onClick={() => drill('latest', row)}
                >
                  查看记录
                </button>
              </CompactRecord>
            ))}
          >
            {tableRows.map(row => (
              <tr key={row.id}>
                <td className="px-3 py-3">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${row.sku} ${row.storeCode}`}
                    checked={selected.includes(row.id)}
                    onChange={e =>
                      setSelected(
                        e.target.checked
                          ? [...selected, row.id]
                          : selected.filter(id => id !== row.id)
                      )
                    }
                  />
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <p className="font-medium text-gray-900">{row.model}</p>
                  <p className="text-gray-600">
                    {row.capacity} · {row.color}
                  </p>
                  <p className="text-xs text-gray-400">{row.sku}</p>
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {row.city}
                  <p className="text-gray-500">Apple {row.storeName}</p>
                </td>
                <td className="px-3 py-3">
                  <Status value={row.displayStatus} />
                </td>
                <td className="px-3 py-3 min-w-[150px]">
                  <p>{row.quote || '尚无有效提示'}</p>
                  {row.lastStatus && (
                    <p className="text-xs text-gray-500">上次：{STATUS[row.lastStatus]}</p>
                  )}
                  {row.error && <p className="text-xs text-red-600">{failureText(row.error)}</p>}
                </td>
                <td className="px-3 py-3 text-xs whitespace-nowrap">
                  {timeText(row.observedAt)}
                  <p className="text-gray-400 mt-1">尝试：{timeText(row.lastAttemptAt)}</p>
                </td>
                <td className="px-3 py-3">
                  <button
                    className="text-primary min-h-[44px] whitespace-nowrap"
                    onClick={() => drill('latest', row)}
                  >
                    查看记录
                  </button>
                </td>
              </tr>
            ))}
          </Table>
          <Pager data={data} onChange={setPage} busy={busy || loading} />
        </>
      )}
      {tab === 'manage' && draft && (
        <>
          <section className="inventory-panel inventory-monitor-settings">
            <div className="basis-full">
              <h2 className="font-semibold">采集设置</h2>
              <p className="text-sm text-gray-500 mt-1">选择商品与门店，保存后开启全国定时采集</p>
            </div>
            <label className="inventory-setting-toggle">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={e => update('enabled', e.target.checked)}
              />
              全局库存监控
            </label>
            <label className="text-sm text-gray-600">
              全国正常周期（秒）
              <input
                type="number"
                className="input block mt-1 w-40"
                min="60"
                max="3600"
                value={draft.intervalSeconds}
                onChange={e => update('intervalSeconds', +e.target.value)}
              />
            </label>
            <button
              className="btn inline-flex items-center justify-center gap-2 btn-primary min-h-[44px]"
              disabled={busy}
              onClick={save}
            >
              保存监控设置
            </button>
            <button
              className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const result = await api.get('settings');
                  setSettings(result.data);
                  setDraft(result.data.config);
                }, '已载入最新设置，请重新修改后保存')
              }
            >
              重新载入设置
            </button>
            <button
              className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
              disabled={busy || !settings.config.enabled}
              onClick={() =>
                act(async () => {
                  await api.post('refresh');
                }, '全国手动轮次已排队')
              }
            >
              立即检查全部
            </button>
            <p className="text-xs text-gray-500 basis-full">
              启用商品 × 启用门店构成固定轮次；个人列表和通知筛选不缩小采集范围。
            </p>
          </section>
          <section className="space-y-3">
            <div className="flex flex-wrap gap-2 justify-between">
              <div className="flex gap-2">
                <button
                  className={`btn ${catalogKind === 'products' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    setCatalogKind('products');
                    setCatalogSelected([]);
                  }}
                >
                  商品 ({catalog.products.length})
                </button>
                <button
                  className={`btn ${catalogKind === 'stores' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    setCatalogKind('stores');
                    setCatalogSelected([]);
                  }}
                >
                  门店 ({catalog.stores.length})
                </button>
              </div>
              <button
                className="btn inline-flex items-center justify-center gap-2 btn-secondary"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await api.post('catalog/refresh');
                  }, '目录核对已排队，失败不会删除现有目录')
                }
              >
                核对官方目录
              </button>
            </div>
            <div className="flex gap-2">
              <button
                className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
                disabled={busy || !catalogSelected.length}
                onClick={() => updateCatalog(true)}
              >
                启用所选
              </button>
              <button
                className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
                disabled={busy || !catalogSelected.length}
                onClick={() => updateCatalog(false)}
              >
                停用所选
              </button>
              <span className="text-sm text-gray-500 self-center">
                已选 {catalogSelected.length}
              </span>
            </div>
            <div className="inventory-catalog-scroll">
              <Table
                headers={[
                  <input
                    key="all"
                    type="checkbox"
                    aria-label="全选目录"
                    checked={
                      currentCatalog.length > 0 && catalogSelected.length === currentCatalog.length
                    }
                    onChange={e =>
                      setCatalogSelected(e.target.checked ? currentCatalog.map(r => r.id) : [])
                    }
                  />,
                  catalogKind === 'products' ? '商品 / 精确 SKU' : '城市 / 门店代码',
                  '状态',
                  '最近目录核对',
                ]}
                empty={!currentCatalog.length}
                label="监控目录"
                mobileHeader={
                  <label className="flex items-center gap-2 min-h-[44px]">
                    <input
                      type="checkbox"
                      aria-label="全选目录"
                      checked={
                        currentCatalog.length > 0 &&
                        catalogSelected.length === currentCatalog.length
                      }
                      onChange={e =>
                        setCatalogSelected(e.target.checked ? currentCatalog.map(r => r.id) : [])
                      }
                    />
                    全选目录
                    <span className="ml-auto text-gray-500">{currentCatalog.length} 项</span>
                  </label>
                }
                mobileChildren={currentCatalog.map(row => (
                  <CompactRecord
                    key={row.id}
                    title={
                      catalogKind === 'products'
                        ? row.model
                        : `${row.city} · Apple ${row.storeName}`
                    }
                    subtitle={
                      catalogKind === 'products' ? `${row.capacity} · ${row.color}` : row.id
                    }
                    status={<Status value={row.enabled ? 'normal' : 'disabled'} />}
                    selection={
                      <input
                        type="checkbox"
                        aria-label={`选择目录 ${row.id}`}
                        checked={catalogSelected.includes(row.id)}
                        onChange={e =>
                          setCatalogSelected(
                            e.target.checked
                              ? [...catalogSelected, row.id]
                              : catalogSelected.filter(id => id !== row.id)
                          )
                        }
                      />
                    }
                  >
                    <RecordFields
                      fields={[
                        [catalogKind === 'products' ? '精确 SKU' : '门店代码', row.id],
                        ['最近目录核对', timeText(row.lastSeenAt)],
                      ]}
                    />
                  </CompactRecord>
                ))}
              >
                {currentCatalog.map(row => (
                  <tr key={row.id}>
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label={`选择目录 ${row.id}`}
                        checked={catalogSelected.includes(row.id)}
                        onChange={e =>
                          setCatalogSelected(
                            e.target.checked
                              ? [...catalogSelected, row.id]
                              : catalogSelected.filter(id => id !== row.id)
                          )
                        }
                      />
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {catalogKind === 'products'
                        ? `${row.model} · ${row.capacity} · ${row.color}`
                        : `${row.city} · Apple ${row.storeName}`}
                      <p className="text-xs text-gray-400">{row.id}</p>
                    </td>
                    <td className="px-3 py-3">
                      <Status value={row.enabled ? 'normal' : 'disabled'} />
                    </td>
                    <td className="px-3 py-3 text-xs whitespace-nowrap">
                      {timeText(row.lastSeenAt)}
                    </td>
                  </tr>
                ))}
              </Table>
            </div>
          </section>
          <section>
            <h2 className="font-medium mb-3">轮次与覆盖审计</h2>
            <p className="text-sm text-gray-500 mb-3">
              下一轮：{timeText(health?.nextRoundAt)} · 最近成功：{timeText(health?.lastSuccessAt)}
            </p>
            <Table
              headers={['计划时间 / 来源', '状态', '完成 / 计划', '失败 / 待采', '耗时 / 重试']}
              mobileChildren={tableRows.map(row => (
                <CompactRecord
                  key={row.id}
                  title={timeText(row.plannedAt)}
                  subtitle={`${STATUS[row.source]} · 完成 ${row.completed} / ${row.expected}`}
                  status={<Status value={row.status} />}
                >
                  <RecordFields
                    fields={[
                      ['失败 / 待采', `${row.failed} / ${row.pending}`],
                      [
                        '耗时 / 重试',
                        `${row.finishedAt && row.startedAt ? `${((row.finishedAt - row.startedAt) / 1000).toFixed(1)} 秒` : '—'} / ${row.retries}`,
                      ],
                    ]}
                  />
                  <button
                    className="btn btn-secondary w-full mt-3"
                    onClick={() => setRoundId(row.id)}
                  >
                    {row.completed} / {row.expected} · 查看覆盖
                  </button>
                </CompactRecord>
              ))}
              empty={!tableRows.length}
            >
              {tableRows.map(row => (
                <tr key={row.id}>
                  <td className="px-3 py-3 whitespace-nowrap">
                    {timeText(row.plannedAt)}
                    <p className="text-xs text-gray-500">{STATUS[row.source]}</p>
                  </td>
                  <td className="px-3 py-3">
                    <Status value={row.status} />
                  </td>
                  <td className="px-3 py-3">
                    <button
                      className="text-primary min-h-[44px] whitespace-nowrap"
                      onClick={() => setRoundId(row.id)}
                    >
                      {row.completed} / {row.expected} · 查看覆盖
                    </button>
                  </td>
                  <td className="px-3 py-3">
                    {row.failed} / {row.pending}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    {row.finishedAt && row.startedAt
                      ? `${((row.finishedAt - row.startedAt) / 1000).toFixed(1)} 秒`
                      : '—'}{' '}
                    / {row.retries}
                  </td>
                </tr>
              ))}
            </Table>
            <Pager data={data} onChange={setPage} busy={loading} />
          </section>
        </>
      )}
      {tab === 'history' && (
        <>
          {data?.detailsPartiallyExpired && (
            <p className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              {timeText(data.retainedFrom)}{' '}
              之前的明细已超保留期，当前结果仅包含仍保留的记录；较早数据请查看小时统计。
            </p>
          )}
          <div className="flex justify-between gap-2 items-center">
            <p className="text-sm text-gray-500">
              检测时间是系统发现时间，不代表 Apple 实际放货时间。
            </p>
            <button
              className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px] shrink-0"
              disabled={busy}
              onClick={exportHistory}
            >
              <Download className="w-4 h-4" />
              导出
            </button>
          </div>
          <Table
            headers={['发现时间', '城市 / 门店', '商品配置', '检测 / 事件', '来源', '官网提示']}
            empty={!tableRows.length}
            label="库存历史"
            mobileChildren={tableRows.map(row => (
              <CompactRecord
                key={row.id}
                title={row.model}
                subtitle={`${row.capacity} · ${row.color} / ${row.city} ${row.storeName}`}
                status={<Status value={row.kind || row.status} />}
                meta={`${timeText(row.observedAt)} · ${STATUS[row.source]}`}
              >
                <RecordFields
                  fields={[
                    ['精确 SKU', row.sku],
                    ['官网提示', row.quote],
                  ]}
                />
              </CompactRecord>
            ))}
          >
            {tableRows.map(row => (
              <tr key={row.id}>
                <td className="px-3 py-3 whitespace-nowrap text-xs">{timeText(row.observedAt)}</td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {row.city} · {row.storeName}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {row.model}
                  <p className="text-gray-500">
                    {row.capacity} · {row.color}
                  </p>
                </td>
                <td className="px-3 py-3">
                  <Status value={row.kind || row.status} />
                </td>
                <td className="px-3 py-3 whitespace-nowrap">{STATUS[row.source]}</td>
                <td className="px-3 py-3 min-w-[130px]">{row.quote || '—'}</td>
              </tr>
            ))}
          </Table>
          <Pager data={data} onChange={setPage} busy={loading} />
        </>
      )}
      {tab === 'analysis' && (
        <InventoryAnalysisView key={`${from}:${to}:${bucketMinutes}`} data={data} onDrill={drill} />
      )}
      {tab === 'settings' && draft && (
        <>
          <section className="inventory-panel p-4 sm:p-5 space-y-4">
            <h2 className="font-medium flex items-center gap-2">
              <Bell className="w-5 h-5 text-primary" />
              库存通知
            </h2>
            <p className="text-sm text-gray-500">
              与订单群配置和队列独立。保存后发送合成测试，核对群内收到后再启用。接口接受不等于群内已读。
            </p>
            <label className="inventory-setting-toggle">
              <input
                type="checkbox"
                checked={draft.notificationsEnabled}
                onChange={e => update('notificationsEnabled', e.target.checked)}
              />
              开启自动库存通知（只提醒新事件）
            </label>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="text-sm">
                群名称
                <input
                  className="input mt-1 w-full"
                  value={draft.groupName}
                  onChange={e => update('groupName', e.target.value)}
                />
              </label>
              <label className="text-sm">
                Webhook（加密保存，不回显）
                <input
                  className="input mt-1 w-full"
                  type="password"
                  autoComplete="new-password"
                  value={webhook}
                  placeholder={
                    settings.hasWebhook ? '已保存；留空保持现有配置' : '企业微信机器人 Webhook'
                  }
                  onChange={e => setWebhook(e.target.value)}
                />
              </label>
              <label className="text-sm">
                静默开始（北京时间）
                <input
                  type="time"
                  className="input mt-1 w-full"
                  value={draft.silentStart}
                  onChange={e => update('silentStart', e.target.value)}
                />
              </label>
              <label className="text-sm">
                静默结束（北京时间）
                <input
                  type="time"
                  className="input mt-1 w-full"
                  value={draft.silentEnd}
                  onChange={e => update('silentEnd', e.target.value)}
                />
              </label>
            </div>
            <details>
              <summary className="cursor-pointer text-sm text-primary min-h-[44px] flex items-center">
                通知范围（留空表示全部启用范围）
              </summary>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 pt-2">
                {Object.entries({
                  cities: ['城市', catalog.stores, 'city'],
                  stores: ['门店', catalog.stores, 'storeCode'],
                  models: ['型号', catalog.products, 'model'],
                  capacities: ['容量', catalog.products, 'capacity'],
                  colors: ['颜色', catalog.products, 'color'],
                }).map(([key, [label, items, field]]) => (
                  <MultiSelect
                    key={key}
                    label={`通知${label}`}
                    values={draft.notificationFilters[key] || []}
                    options={[...new Set(items.map(r => r[field]))].map(v => ({
                      value: v,
                      label:
                        key === 'stores'
                          ? `${catalog.stores.find(s => s.storeCode === v)?.storeName} (${v})`
                          : v,
                    }))}
                    onChange={value =>
                      update('notificationFilters', { ...draft.notificationFilters, [key]: value })
                    }
                  />
                ))}
              </div>
            </details>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn inline-flex items-center justify-center gap-2 btn-primary min-h-[44px]"
                disabled={busy}
                onClick={save}
              >
                保存通知设置
              </button>
              <button
                className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
                disabled={busy || !settings.hasWebhook}
                onClick={() =>
                  act(async () => {
                    await api.post('notifications/test');
                  }, '合成测试已排队，请核对群内收件后再启用')
                }
              >
                发送合成测试
              </button>
              <button
                className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const result = await api.get('settings');
                    setSettings(result.data);
                    setDraft(result.data.config);
                  }, '已刷新测试状态')
                }
              >
                刷新测试状态
              </button>
              <span className="text-sm text-gray-500 self-center">
                {settings.webhookTested ? '测试接口已接受' : '尚未完成测试'}
              </span>
            </div>
          </section>
          <section className="inventory-panel p-4 sm:p-5 space-y-3">
            <h2 className="font-medium flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              运行健康与预算
            </h2>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <p>
                采集状态：
                <Status value={health?.state} />
              </p>
              <p>Worker 心跳：{timeText(health?.workerHeartbeat)}</p>
              <p>
                小时请求：{health?.hourCount || 0} / {draft.hourlyRequests}
              </p>
              <p>
                日请求：{health?.dayCount || 0} / {draft.dailyRequests}
              </p>
              <p>
                今日响应流量：{((health?.dailyBytes || 0) / 1048576).toFixed(2)} MiB（含在途预占）
              </p>
              <p>
                今日代理提取：{health?.proxyExtractions || 0} / {draft.dailyProxyExtractions}
              </p>
              <p>最近风险比例：{((health?.riskRatio || 0) * 100).toFixed(1)}%</p>
              <p>最近错误：{failureText(health?.reason)}</p>
              <p>
                库存排队：{health?.queue?.queuedRounds || 0} 轮；通知待发：
                {health?.queue?.pendingNotifications || 0} 条
              </p>
            </div>
            <button
              className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await api.post('resume');
                }, '已进入有限恢复探测，冷却和预算不会清零')
              }
            >
              已核查，恢复探测
            </button>
            <details>
              <summary className="cursor-pointer min-h-[44px] flex items-center text-sm text-primary">
                请求预算与数据保留
              </summary>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {Object.entries({
                  hourlyRequests: '每小时请求上限',
                  dailyRequests: '每日请求上限',
                  dailyBytes: '每日响应字节上限',
                  dailyProxyExtractions: '每日代理提取上限',
                  notificationTtlSeconds: '通知有效秒数',
                  samplesDays: '检测明细保留天数',
                  eventsDays: '事件保留天数',
                  hourlyDays: '小时统计保留天数',
                }).map(([key, label]) => (
                  <label key={key} className="text-sm text-gray-600">
                    {label}
                    <input
                      className="input mt-1 w-full"
                      type="number"
                      value={draft[key]}
                      onChange={e => update(key, +e.target.value)}
                    />
                  </label>
                ))}
              </div>
              <button
                className="btn inline-flex items-center justify-center gap-2 btn-primary mt-3 min-h-[44px]"
                disabled={busy}
                onClick={save}
              >
                保存预算与保留期
              </button>
            </details>
          </section>
          <section>
            <h2 className="font-medium mb-3">独立通知投递记录</h2>
            <Table
              headers={['类型', '结果', '尝试次数', '发送时间', '原因']}
              empty={!tableRows.length}
              label="通知投递"
              mobileChildren={tableRows.map(row => (
                <CompactRecord
                  key={row.id}
                  title={STATUS[row.kind] || row.kind}
                  subtitle={timeText(row.sentAt)}
                  status={
                    <Status value={row.status === 'unknown' ? 'delivery_unknown' : row.status} />
                  }
                >
                  <RecordFields
                    fields={[
                      ['尝试次数', String(row.attempts)],
                      ['原因', row.errorCode],
                    ]}
                  />
                </CompactRecord>
              ))}
            >
              {tableRows.map(row => (
                <tr key={row.id}>
                  <td className="px-3 py-3 whitespace-nowrap">{STATUS[row.kind] || row.kind}</td>
                  <td className="px-3 py-3">
                    <Status value={row.status === 'unknown' ? 'delivery_unknown' : row.status} />
                  </td>
                  <td className="px-3 py-3">{row.attempts}</td>
                  <td className="px-3 py-3 text-xs whitespace-nowrap">{timeText(row.sentAt)}</td>
                  <td className="px-3 py-3">{row.errorCode || '—'}</td>
                </tr>
              ))}
            </Table>
            <Pager data={data} onChange={setPage} busy={loading} />
          </section>
        </>
      )}
    </div>
  );
}

/** 两个菜单边界：用户查询组三页签、管理员配置组两页签。旧链接先归组再由路由鉴权。 */
export default function InventoryMonitor({ mode = 'read' }) {
  const location = useLocation();
  const requested = new URLSearchParams(location.search).get('tab');
  const fallback = mode === 'admin' ? 'manage' : 'latest';
  const view = TABS[requested] ? requested : fallback;
  const targetMode = ['manage', 'settings'].includes(view) ? 'admin' : 'read';
  if (targetMode !== mode)
    return (
      <Navigate
        to={`${targetMode === 'admin' ? '/inventory-monitor/manage' : '/inventory-monitor'}?tab=${view}`}
        replace
      />
    );
  return <InventoryView key={view} view={view} mode={mode} />;
}
