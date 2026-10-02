import { STATUS, timeText } from '../components/inventory/inventoryPresentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PackageSearch, RefreshCw, Copy, Download, Bell, Activity } from 'lucide-react';
import { inventoryApi as api } from '../api/inventoryApi';
import {
  InventoryFilters,
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
  analysis: '分析统计',
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
/** 管理员库存模块：五个视图共享筛选及有界后台队列。 */
export default function InventoryMonitor() {
  const [params, setParams] = useSearchParams();
  const tab = TABS[params.get('tab')] ? params.get('tab') : 'latest';
  const [roundId, setRoundId] = useState(null);
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [filters, setFilters] = useState({});
  const [applied, setApplied] = useState({});
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
  const [metric, setMetric] = useState('arrivals');
  const [source, setSource] = useState('all');
  const [bucketMinutes, setBucketMinutes] = useState(60);
  const [hour, setHour] = useState('');
  const [from, setFrom] = useState(() => `${localDate(new Date()).slice(0, 10)}T00:00`);
  const [to, setTo] = useState(() => localDate(new Date(Date.now() + 60000)));
  const sequence = useRef(0);
  const mounted = useRef(true);
  const switchTab = name => {
    if (name === 'analysis' && metric === 'all') setMetric('arrivals');
    sequence.current += 1;
    setParams({ tab: name });
    setPage(1);
    setData(null);
    setSelected([]);
    setNotice('');
    setError('');
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
        const [result, h] = await Promise.all([
          api.get(path, { ...query, page, pageSize: 50 }),
          api.get('health'),
        ]);
        if (id !== sequence.current || !mounted.current) return;
        setData(result.data);
        setHealth(h.data);
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
    [tab, applied, onlyInStock, page, bucketMinutes, historyParams]
  );
  useEffect(() => {
    mounted.current = true;
    const initial = async () => {
      try {
        const [c, s] = await Promise.all([api.get('catalog'), api.get('settings')]);
        if (mounted.current) {
          setCatalog(c.data);
          setSettings(s.data);
          setDraft(s.data.config);
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
  }, []);
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
    switchTab('history');
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
    <div className="space-y-5 min-w-0">
      {roundId && <InventoryCoverageDialog id={roundId} onClose={() => setRoundId(null)} />}
      <header className="flex flex-wrap gap-3 items-start justify-between">
        <div className="flex gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
            <PackageSearch className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">库存监控</h1>
            <p className="text-sm text-gray-500 mt-1">
              大陆 Apple 直营店 · iPhone · 发现时间均为北京时间
            </p>
          </div>
        </div>
        <button
          className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
          onClick={() => load()}
          disabled={busy || loading}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          刷新页面
        </button>
      </header>
      <nav className="flex overflow-x-auto gap-1 border-b border-gray-200" aria-label="库存功能">
        {Object.entries(TABS).map(([key, title]) => (
          <button
            key={key}
            className={`shrink-0 px-4 py-3 min-h-[48px] text-sm font-medium border-b-2 ${tab === key ? 'border-primary text-primary' : 'border-transparent text-gray-500 hover:text-gray-900'}`}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => switchTab(key)}
          >
            {title}
          </button>
        ))}
      </nav>
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
      {health && (health.paused || !settings?.config.enabled) && (
        <p className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          {!settings?.config.enabled
            ? '全局监控已关闭，页面保留上次结果。'
            : `采集保护：${STATUS[health.state] || health.state}；${health.reason || '等待冷却到期'}`}{' '}
          {health.cooldownUntil ? `截止 ${timeText(health.cooldownUntil)}` : ''}
        </p>
      )}
      {['latest', 'history', 'analysis'].includes(tab) && (
        <InventoryFilters
          catalog={catalog}
          filters={filters}
          onChange={setFilters}
          onApply={apply}
        />
      )}
      {['history', 'analysis'].includes(tab) && (
        <section className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
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
              <select
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
              </select>
            </label>
            <label className="text-sm text-gray-600">
              采集来源
              <select
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
              </select>
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
                <select
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
                </select>
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
        </section>
      )}
      {loading && !data && (
        <p role="status" className="py-10 text-center text-gray-500">
          正在加载库存数据…
        </p>
      )}
      {tab === 'latest' && (
        <>
          <div className="flex flex-wrap gap-3 items-center justify-between">
            <p className="text-sm text-gray-600">
              筛选内 {data?.summary?.combinations || 0} 个组合 · 新鲜 {data?.summary?.fresh || 0} ·
              有货门店 {data?.summary?.currentStores || 0}
              <span className="block text-xs text-gray-400 mt-1">
                页面每 10 秒读取缓存；官网采集时间见各行
              </span>
            </p>
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
                  {row.error && <p className="text-xs text-red-600">{row.error}</p>}
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
          <section className="bg-white border border-gray-200 rounded-lg p-4 flex flex-wrap items-end gap-4">
            <label className="flex items-center gap-2 min-h-[44px]">
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
            <div className="max-h-[420px] overflow-y-auto">
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
          <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
            <h2 className="font-medium flex items-center gap-2">
              <Bell className="w-5 h-5 text-primary" />
              独立库存群
            </h2>
            <p className="text-sm text-gray-500">
              与订单群配置和队列独立。保存后发送合成测试，核对群内收到后再启用。接口接受不等于群内已读。
            </p>
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
            <label className="flex items-center gap-2 min-h-[44px] text-sm">
              <input
                type="checkbox"
                checked={draft.notificationsEnabled}
                onChange={e => update('notificationsEnabled', e.target.checked)}
              />
              开启自动库存通知（只提醒新事件）
            </label>
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
          <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
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
              <p>最近错误：{health?.reason || '无'}</p>
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
