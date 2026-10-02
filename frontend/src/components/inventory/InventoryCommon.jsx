import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, X, Search, SlidersHorizontal, Inbox, Check } from 'lucide-react';
import { STATUS } from './inventoryPresentation';

/** 统一状态徽章，失败、未知与无货保持独立语义。 */
export function Status({ value }) {
  return (
    <span
      className={`badge inventory-status ${['in_stock', 'complete', 'normal', 'accepted'].includes(value) ? 'bg-green-100 text-green-700' : ['error', 'failed', 'manual_required'].includes(value) ? 'bg-red-100 text-red-700' : ['stale', 'paused', 'partial'].includes(value) ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'}`}
    >
      <span className="inventory-status-dot" aria-hidden="true" />
      {STATUS[value] || value || '—'}
    </span>
  );
}

/** 原生模态约束焦点并锁定背景，支持短屏与安全区。 */
export function InventoryDialog({ title, onClose, children, className = '', returnFocusRef }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    const dialog = ref.current;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      dialog.close();
      (returnFocusRef?.current || previous)?.focus();
    };
  }, [returnFocusRef]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`inventory-dialog ${className}`}
      onCancel={onClose}
      onClick={event => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="inventory-dialog-frame">
        <div className="inventory-dialog-heading">
          <h2 id={titleId} className="font-semibold text-gray-900">
            {title}
          </h2>
          <button
            type="button"
            className="btn btn-secondary inventory-icon-button"
            aria-label={`关闭${title}`}
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

/** 桌面搜索下拉，触屏使用有焦点约束的多选弹层。 */
export function MultiSelect({ label, options, values = [], onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const root = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const change = () => {
      setMobile(query.matches);
      setOpen(false);
    };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!open || mobile) return undefined;
    const closeOutside = event => {
      if (!root.current.contains(event.target)) setOpen(false);
    };
    const escape = event => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, mobile]);
  const filtered = options.filter(option =>
    option.label.toLowerCase().includes(search.toLowerCase())
  );
  const content = (
    <>
      <div className="inventory-picker-search">
        <Search className="w-4 h-4 text-gray-400 shrink-0" />
        <input
          className="input min-w-0"
          aria-label={`搜索${label}`}
          placeholder={`搜索${label}`}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {!mobile && (
          <button
            className="btn btn-secondary inventory-icon-button"
            aria-label={`关闭${label}`}
            onClick={() => setOpen(false)}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <div className="inventory-picker-options" role="group" aria-label={label}>
        {filtered.map(option => (
          <label
            key={option.value}
            className={`inventory-picker-option ${values.includes(option.value) ? 'bg-blue-50 text-primary' : ''}`}
          >
            <input
              type="checkbox"
              checked={values.includes(option.value)}
              onChange={e =>
                onChange(
                  e.target.checked
                    ? [...values, option.value]
                    : values.filter(v => v !== option.value)
                )
              }
            />
            <span>{option.label}</span>
          </label>
        ))}
        {!filtered.length && (
          <p className="py-8 text-center text-sm text-gray-500">没有匹配的选项</p>
        )}
      </div>
      <div className="inventory-picker-footer">
        <button className="btn btn-secondary" onClick={() => onChange([])}>
          清空选择
        </button>
        <button
          className="btn btn-primary inline-flex items-center gap-2"
          onClick={() => setOpen(false)}
        >
          <Check className="w-4 h-4" />
          完成{values.length ? ` (${values.length})` : ''}
        </button>
      </div>
    </>
  );
  return (
    <div ref={root} className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        className={`btn btn-secondary inventory-picker-trigger ${values.length ? 'inventory-picker-active' : ''}`}
        aria-expanded={open}
        aria-haspopup={mobile ? 'dialog' : undefined}
        onClick={() => {
          setSearch('');
          setOpen(!open);
        }}
      >
        <span>
          {label}
          {values.length ? ` (${values.length})` : ''}
        </span>
        <ChevronDown className="w-4 h-4 shrink-0" />
      </button>
      {open &&
        (mobile ? (
          <InventoryDialog title={label} returnFocusRef={trigger} onClose={() => setOpen(false)}>
            {content}
          </InventoryDialog>
        ) : (
          <div className="inventory-picker-popover">{content}</div>
        ))}
    </div>
  );
}

/** 手机收起次要筛选，桌面始终展开，条件不因收起而丢失。 */
export function FilterSection({ title, summary, children, collapseKey }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    setOpen(false);
  }, [collapseKey]);
  return (
    <section className="inventory-panel inventory-filter-panel">
      <div className="inventory-filter-heading">
        <span className="hidden md:inline-flex items-center gap-2 font-medium text-gray-700">
          <SlidersHorizontal className="w-4 h-4 text-primary" />
          {title}
        </span>
        <button
          className="inventory-filter-toggle md:hidden"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          <SlidersHorizontal className="w-4 h-4 text-primary" />
          <span>{title}</span>
          <ChevronDown
            className={`w-4 h-4 ml-auto transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
        <span className="inventory-filter-summary">{summary}</span>
      </div>
      <div id={id} className={`${open ? 'block' : 'hidden'} md:block inventory-filter-content`}>
        {children}
      </div>
    </section>
  );
}

/** 全国共用筛选；摘要只显示已应用条件，重置同时恢复查询。 */
export function InventoryFilters({ catalog, filters, applied, onChange, onApply, onReset }) {
  const uniq = (items, field) =>
    [...new Set(items.map(r => r[field]).filter(Boolean))]
      .sort()
      .map(v => ({ value: v, label: v }));
  const labels = {
    cities: '城市',
    stores: '门店',
    models: '型号',
    capacities: '容量',
    colors: '颜色',
  };
  const options = {
    cities: uniq(catalog.stores, 'city'),
    stores: catalog.stores
      .filter(s => !filters.cities?.length || filters.cities.includes(s.city))
      .map(s => ({ value: s.storeCode, label: `${s.city} · ${s.storeName}` })),
    models: uniq(catalog.products, 'model'),
    capacities: uniq(catalog.products, 'capacity'),
    colors: uniq(catalog.products, 'color'),
    skus: catalog.products.map(product => ({
      value: product.sku,
      label: `${product.model} · ${product.capacity} · ${product.color} (${product.sku})`,
    })),
  };
  const count = Object.values(applied).reduce((sum, items) => sum + items.length, 0);
  const dirty = JSON.stringify(filters) !== JSON.stringify(applied);
  const summary = Object.entries(applied)
    .filter(([, items]) => items.length)
    .map(
      ([key, items]) =>
        `${labels[key] || (key === 'skus' ? '精确商品' : key)} ${items.map(value => options[key]?.find(option => option.value === value)?.label || value).join('、')}`
    )
    .join(' · ');
  return (
    <FilterSection
      title="商品与门店筛选"
      summary={count ? summary : '全部城市 · 全部商品'}
      collapseKey={JSON.stringify(applied)}
    >
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        {Object.entries(labels).map(([key, label]) => (
          <MultiSelect
            key={key}
            label={label}
            options={options[key]}
            values={filters[key] || []}
            onChange={value => onChange({ ...filters, [key]: value })}
          />
        ))}
      </div>
      <div className="inventory-filter-actions">
        <button
          className="btn btn-primary inline-flex items-center justify-center gap-2"
          onClick={onApply}
        >
          <Search className="w-4 h-4" />
          应用筛选
        </button>
        <button className="btn btn-secondary" onClick={onReset}>
          重置选择
        </button>
        <span className={`text-xs ${dirty ? 'text-amber-700' : 'text-gray-500'}`}>
          {dirty ? '条件已修改，应用后生效' : '个人筛选不改变全国采集范围'}
        </span>
      </div>
    </FilterSection>
  );
}

/** 连续列表的紧凑行，次要字段通过原生展开控件完整保留。 */
export function CompactRecord({ title, subtitle, status, selection, meta, children }) {
  return (
    <li className="inventory-compact-record">
      <div className="flex items-start gap-2">
        {selection && <label className="inventory-selection">{selection}</label>}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-gray-900 break-words">{title}</p>
          <p className="mt-1 text-sm text-gray-500 break-words">{subtitle}</p>
        </div>
        {status && <div className="shrink-0 pt-0.5">{status}</div>}
      </div>
      {meta && <p className="mt-2 text-xs text-gray-500">{meta}</p>}
      {children && (
        <details className="inventory-row-details">
          <summary>
            查看详情
            <ChevronDown className="w-4 h-4" />
          </summary>
          <div className="inventory-row-detail-body">{children}</div>
        </details>
      )}
    </li>
  );
}

/** 完整字段按中文标签呈现，长错误与 SKU 可换行。 */
export function RecordFields({ fields }) {
  return (
    <dl className="inventory-record-fields">
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 有边界的服务器分页。 */
export function Pager({ data, onChange, busy }) {
  return (
    <div className="inventory-pager">
      <span>
        共 {data?.total || 0} 条 · 第 {data?.page || 1} 页
      </span>
      <div className="flex gap-2">
        <button
          className="btn btn-secondary"
          disabled={busy || !data || data.page <= 1}
          onClick={() => onChange(data.page - 1)}
        >
          上一页
        </button>
        <button
          className="btn btn-secondary"
          disabled={busy || !data || data.page * data.pageSize >= data.total}
          onClick={() => onChange(data.page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}

/** 桌面表格及手机连续列表共用同一数据和空态。 */
export function Table({
  headers,
  children,
  mobileChildren,
  mobileHeader,
  empty,
  label = '数据表格',
}) {
  return (
    <div className="inventory-table-panel" role="region" aria-label={label}>
      {mobileChildren && !empty && (
        <div className="md:hidden">
          {mobileHeader && <div className="inventory-list-heading">{mobileHeader}</div>}
          <ul className="divide-y divide-gray-100">{mobileChildren}</ul>
        </div>
      )}
      <div
        className={`${mobileChildren && !empty ? 'hidden md:block' : ''} overflow-x-auto`}
        tabIndex={0}
        aria-label={`${label}表格滚动区`}
      >
        <table className="inventory-table">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {empty ? (
              <tr>
                <td colSpan={headers.length} className="inventory-empty">
                  <Inbox className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                  <p>当前条件下暂无记录</p>
                  <p className="text-xs mt-1 text-gray-400">可调整筛选条件，或稍后刷新查看</p>
                </td>
              </tr>
            ) : (
              children
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
