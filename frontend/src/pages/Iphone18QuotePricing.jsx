import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BadgeDollarSign,
  Check,
  Copy,
  ExternalLink,
  GripVertical,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
} from 'lucide-react';
import {
  getIphone18QuotePricing,
  getIphone18QuoteVersions,
  resetIphone18QuoteAdjustments,
  restoreIphone18QuoteVersion,
  saveIphone18QuoteAdjustments,
  saveIphone18QuoteDisplayOrder,
  setIphone18QuoteAvailability,
} from '../api/quotePricingApi';

const formatCurrency = value =>
  value === null || value === undefined
    ? '-'
    : new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: 'CNY',
        maximumFractionDigits: 0,
      }).format(value);

const formatTime = value =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '-';

const storageLabel = value =>
  value >= 1024 && value % 1024 === 0 ? `${value / 1024}TB` : `${value}GB`;

const colorOrder = ['黑色', '银色', '冰川蓝色', '勃艮第酒红色'];
const compareColors = (left, right) => {
  const leftIndex = colorOrder.indexOf(left);
  const rightIndex = colorOrder.indexOf(right);
  if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right, 'zh-CN');
  if (leftIndex === -1) return 1;
  if (rightIndex === -1) return -1;
  return leftIndex - rightIndex;
};

const actionLabels = {
  bulk_adjust: '批量调价',
  reset: '恢复原价',
  restore: '版本回退',
};

/** 管理员 Apple 报价调整与版本管理。 */
export default function Iphone18QuotePricing() {
  const [data, setData] = useState(null);
  const [versions, setVersions] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [draftOrder, setDraftOrder] = useState([]);
  const [draggingKey, setDraggingKey] = useState('');
  const [filters, setFilters] = useState({ productModel: '', storageGb: '', color: '' });
  const [percentage, setPercentage] = useState('0');
  const [fixedAmount, setFixedAmount] = useState('0');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [pricing, history] = await Promise.all([
        getIphone18QuotePricing(),
        getIphone18QuoteVersions(),
      ]);
      setData(pricing.data);
      setDraftOrder(pricing.data.items.map(item => item.productKey));
      setVersions(history.data.items);
      setSelected(previous => {
        const valid = new Set(pricing.data.items.map(item => item.productKey));
        return new Set([...previous].filter(key => valid.has(key)));
      });
      setError('');
    } catch (failure) {
      setError(failure.message || '读取报价管理数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filterOptions = useMemo(
    () => ({
      models: [...new Set((data?.items || []).map(item => item.productModel))],
      storages: [...new Set((data?.items || []).map(item => item.storageGb))].sort((a, b) => a - b),
      colors: [...new Set((data?.items || []).map(item => item.color))].sort(compareColors),
    }),
    [data?.items]
  );

  const orderedItems = useMemo(() => {
    const items = data?.items || [];
    const byKey = new Map(items.map(item => [item.productKey, item]));
    const ordered = draftOrder.map(key => byKey.get(key)).filter(Boolean);
    const included = new Set(ordered.map(item => item.productKey));
    return [...ordered, ...items.filter(item => !included.has(item.productKey))];
  }, [data?.items, draftOrder]);

  const filteredItems = useMemo(
    () =>
      orderedItems.filter(
        item =>
          (!filters.productModel || item.productModel === filters.productModel) &&
          (!filters.storageGb || item.storageGb === Number(filters.storageGb)) &&
          (!filters.color || item.color === filters.color)
      ),
    [orderedItems, filters]
  );

  const hasActiveFilters = Object.values(filters).some(Boolean);
  const defaultOrder = data?.defaultOrder || [];
  const savedOrder = (data?.items || []).map(item => item.productKey);
  const orderChanged =
    draftOrder.length === savedOrder.length &&
    draftOrder.some((productKey, index) => productKey !== savedOrder[index]);

  const allFilteredSelected =
    filteredItems.length > 0 && filteredItems.every(item => selected.has(item.productKey));

  function toggleOne(key) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleFiltered() {
    setSelected(previous => {
      const next = new Set(previous);
      filteredItems.forEach(item => {
        if (allFilteredSelected) next.delete(item.productKey);
        else next.add(item.productKey);
      });
      return next;
    });
  }

  function moveItem(sourceKey, targetKey) {
    if (hasActiveFilters || sourceKey === targetKey) return;
    setDraftOrder(previous => {
      const sourceIndex = previous.indexOf(sourceKey);
      const targetIndex = previous.indexOf(targetKey);
      if (sourceIndex < 0 || targetIndex < 0) return previous;
      const next = [...previous];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function startDragging(event, productKey) {
    if (hasActiveFilters || busy) {
      event.preventDefault();
      return;
    }
    setDraggingKey(productKey);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', productKey);
  }

  function moveWithKeyboard(event, productKey) {
    if (hasActiveFilters || busy || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = draftOrder.indexOf(productKey);
    const targetIndex = currentIndex + (event.key === 'ArrowUp' ? -1 : 1);
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= draftOrder.length) return;
    moveItem(productKey, draftOrder[targetIndex]);
  }

  async function run(busyKey, action, successMessage) {
    setBusy(busyKey);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(successMessage);
      await load();
    } catch (failure) {
      setError(failure.message || '操作失败');
    } finally {
      setBusy('');
    }
  }

  function applyAdjustments() {
    if (selected.size === 0) return setError('请先选择商品');
    const percent = Number(percentage);
    const fixed = Number(fixedAmount);
    if (!Number.isFinite(percent) || !Number.isFinite(fixed)) return setError('请输入有效调价值');
    return run(
      'save',
      () =>
        saveIphone18QuoteAdjustments({
          productKeys: [...selected],
          percentage: percent,
          fixedAmount: fixed,
          expectedVersion: data.version,
        }),
      `已更新 ${selected.size} 款商品，公开报价立即生效。`
    );
  }

  function resetSelected() {
    if (selected.size === 0) return setError('请先选择商品');
    if (!window.confirm(`确定将选中的 ${selected.size} 款商品恢复为明威原价吗？`)) return;
    return run(
      'reset',
      () =>
        resetIphone18QuoteAdjustments({
          productKeys: [...selected],
          expectedVersion: data.version,
        }),
      `已恢复 ${selected.size} 款商品原价。`
    );
  }

  function toggleAvailability() {
    const enabled = !data.publicEnabled;
    return run(
      'availability',
      () => setIphone18QuoteAvailability({ enabled, expectedVersion: data.version }),
      enabled ? '公开报价链接已开放。' : '公开报价链接已暂停。'
    );
  }

  function saveDisplayOrder() {
    if (!orderChanged) return;
    return run(
      'display-order',
      () =>
        saveIphone18QuoteDisplayOrder({
          productKeys: draftOrder,
          expectedVersion: data.version,
        }),
      '展示顺序已保存，公开报价页面立即生效。'
    );
  }

  function restore(version) {
    if (!window.confirm(`确定恢复到报价版本 #${version.revision} 吗？此操作会生成新版本。`)) {
      return;
    }
    return run(
      `restore-${version.id}`,
      () => restoreIphone18QuoteVersion(version.id, { expectedVersion: data.version }),
      `已恢复报价版本 #${version.revision}。`
    );
  }

  async function copyPublicLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${data.publicPath}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (_error) {
      setError('复制链接失败，请检查浏览器剪贴板权限');
    }
  }

  if (loading && !data) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-gray-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 正在加载报价…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50">
            <BadgeDollarSign className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Apple 报价管理</h1>
            <p className="mt-1 text-sm text-gray-500">选择商品并批量设置对外报价调整</p>
          </div>
        </div>
        <button className="btn btn-secondary inline-flex items-center gap-2" onClick={load}>
          <RefreshCw className="h-4 w-4" /> 刷新数据
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {notice}
        </div>
      )}

      {data && (
        <>
          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className={`badge ${data.publicEnabled ? 'badge-success' : 'badge-warning'}`}
                  >
                    {data.publicEnabled ? '公开中' : '已暂停'}
                  </span>
                  <span className="text-sm font-medium text-gray-900">固定公开报价链接</span>
                </div>
                <p className="mt-2 break-all font-mono text-sm text-primary">
                  {window.location.origin}
                  {data.publicPath}
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  来源报价：{formatTime(data.sourceUpdatedAt)} · 最近检查：
                  {formatTime(data.lastCheckedAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn btn-secondary inline-flex items-center gap-2"
                  onClick={copyPublicLink}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? '已复制' : '复制链接'}
                </button>
                <a
                  href={data.publicPath}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-secondary inline-flex items-center gap-2"
                >
                  <ExternalLink className="h-4 w-4" /> 打开链接
                </a>
                <button
                  className={`btn ${data.publicEnabled ? 'btn-secondary' : 'btn-primary'}`}
                  onClick={toggleAvailability}
                  disabled={Boolean(busy)}
                >
                  {data.publicEnabled ? '暂停公开' : '开放链接'}
                </button>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="grid gap-3 md:grid-cols-3">
              <select
                className="input"
                value={filters.productModel}
                aria-label="型号筛选"
                onChange={event =>
                  setFilters(previous => ({ ...previous, productModel: event.target.value }))
                }
              >
                <option value="">全部型号</option>
                {filterOptions.models.map(value => (
                  <option key={value} value={value}>
                    iPhone {value}
                  </option>
                ))}
              </select>
              <select
                className="input"
                value={filters.storageGb}
                aria-label="容量筛选"
                onChange={event =>
                  setFilters(previous => ({ ...previous, storageGb: event.target.value }))
                }
              >
                <option value="">全部容量</option>
                {filterOptions.storages.map(value => (
                  <option key={value} value={value}>
                    {storageLabel(value)}
                  </option>
                ))}
              </select>
              <select
                className="input"
                value={filters.color}
                aria-label="颜色筛选"
                onChange={event =>
                  setFilters(previous => ({ ...previous, color: event.target.value }))
                }
              >
                <option value="">全部颜色</option>
                {filterOptions.colors.map(value => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-gray-100 pt-4">
              <label className="min-w-[180px] flex-1 text-sm text-gray-700">
                百分比调整
                <div className="relative mt-1">
                  <input
                    className="input pr-9"
                    type="number"
                    min="-100"
                    max="1000"
                    step="0.01"
                    value={percentage}
                    onChange={event => setPercentage(event.target.value)}
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">%</span>
                </div>
              </label>
              <label className="min-w-[180px] flex-1 text-sm text-gray-700">
                固定金额调整
                <div className="relative mt-1">
                  <input
                    className="input pl-8"
                    type="number"
                    min="-100000"
                    max="100000"
                    step="1"
                    value={fixedAmount}
                    onChange={event => setFixedAmount(event.target.value)}
                  />
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">¥</span>
                </div>
              </label>
              <button
                className="btn btn-primary inline-flex items-center gap-2"
                onClick={applyAdjustments}
                disabled={Boolean(busy) || selected.size === 0}
              >
                <Save className="h-4 w-4" /> 应用到 {selected.size} 款
              </button>
              <button
                className="btn btn-secondary inline-flex items-center gap-2"
                onClick={resetSelected}
                disabled={Boolean(busy) || selected.size === 0}
              >
                <RotateCcw className="h-4 w-4" /> 恢复原价
              </button>
            </div>
            <p className="mt-3 text-xs text-gray-500">
              计算顺序：明威原价 ×（1 + 百分比）+
              固定金额，最后四舍五入到整数元。重复保存会覆盖当前规则，不会累加。
            </p>
          </section>

          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
              <div>
                <p className="text-sm text-gray-600">
                  已选择 <span className="font-semibold text-primary">{selected.size}</span> /{' '}
                  {data.items.length} 款
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  {hasActiveFilters
                    ? '清除筛选后可拖动商品行调整公开展示顺序。'
                    : '拖动每行左侧排序图标，保存后公开页面立即按新顺序展示。'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn btn-primary inline-flex items-center gap-2"
                  onClick={saveDisplayOrder}
                  disabled={Boolean(busy) || !orderChanged || hasActiveFilters}
                >
                  <Save className="h-4 w-4" /> 保存展示顺序
                </button>
                <button
                  className="btn btn-secondary inline-flex items-center gap-2"
                  onClick={() => setDraftOrder(defaultOrder)}
                  disabled={Boolean(busy) || hasActiveFilters || defaultOrder.length === 0}
                >
                  <RotateCcw className="h-4 w-4" /> 恢复默认顺序
                </button>
                <button className="btn btn-secondary" onClick={toggleFiltered}>
                  {allFilteredSelected ? '取消当前结果' : `全选当前结果（${filteredItems.length}）`}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => setSelected(new Set(data.items.map(item => item.productKey)))}
                >
                  选择全部商品
                </button>
                <button className="btn btn-secondary" onClick={() => setSelected(new Set())}>
                  清空选择
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[1040px] w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr className="text-left text-xs font-medium text-gray-500">
                    <th className="w-12 px-3 py-3 text-center">排序</th>
                    <th className="w-12 px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label="全选当前结果"
                        checked={allFilteredSelected}
                        onChange={toggleFiltered}
                      />
                    </th>
                    <th className="px-4 py-3">商品</th>
                    <th className="px-4 py-3">规格码</th>
                    <th className="px-4 py-3">明威原价</th>
                    <th className="px-4 py-3">官网价</th>
                    <th className="px-4 py-3">百分比</th>
                    <th className="px-4 py-3">固定金额</th>
                    <th className="px-4 py-3">公开报价</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredItems.map(item => (
                    <tr
                      key={item.productKey}
                      onDragEnter={() => moveItem(draggingKey, item.productKey)}
                      onDragOver={event => {
                        if (!hasActiveFilters) event.preventDefault();
                      }}
                      onDrop={event => {
                        event.preventDefault();
                        setDraggingKey('');
                      }}
                      className={`${selected.has(item.productKey) ? 'bg-blue-50' : 'hover:bg-gray-50'} ${draggingKey === item.productKey ? 'opacity-50' : ''}`}
                    >
                      <td className="px-3 py-3 text-center">
                        <button
                          type="button"
                          draggable={!hasActiveFilters && !busy}
                          aria-label={`拖动 ${item.productName} 调整顺序`}
                          title={hasActiveFilters ? '清除筛选后可调整顺序' : '拖动调整展示顺序'}
                          onDragStart={event => startDragging(event, item.productKey)}
                          onDragEnd={() => setDraggingKey('')}
                          onKeyDown={event => moveWithKeyboard(event, item.productKey)}
                          className="inline-flex h-8 w-8 cursor-grab items-center justify-center rounded-md text-gray-400 hover:bg-blue-50 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-40 active:cursor-grabbing"
                          disabled={hasActiveFilters || Boolean(busy)}
                        >
                          <GripVertical className="h-5 w-5" />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${item.productName}`}
                          checked={selected.has(item.productKey)}
                          onChange={() => toggleOne(item.productKey)}
                        />
                      </td>
                      <td className="min-w-[260px] px-4 py-3 font-medium text-gray-900">
                        {item.productName}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-500">
                        {item.specCode || '-'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {formatCurrency(item.basePrice)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-500">
                        {formatCurrency(item.officialPrice)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {item.percentage > 0 ? '+' : ''}
                        {item.percentage}%
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {item.fixedAmount > 0 ? '+' : ''}
                        {formatCurrency(item.fixedAmount)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-primary">
                        {formatCurrency(item.quotePrice)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
              <History className="h-4 w-4 text-primary" />
              <h2 className="font-semibold text-gray-900">调价版本记录</h2>
            </div>
            {versions.length ? (
              <div className="divide-y divide-gray-100">
                {versions.map(version => (
                  <div
                    key={version.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        #{version.revision} · {actionLabels[version.action] || version.action}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        {version.actorName} · {formatTime(version.createdAt)} · 当前规则{' '}
                        {version.summary?.itemCount ?? 0} 条
                      </p>
                    </div>
                    <button
                      className="btn btn-secondary inline-flex items-center gap-2"
                      onClick={() => restore(version)}
                      disabled={Boolean(busy)}
                    >
                      <RotateCcw className="h-4 w-4" /> 恢复此版本
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-4 py-10 text-center text-sm text-gray-500">暂无调价记录</div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
