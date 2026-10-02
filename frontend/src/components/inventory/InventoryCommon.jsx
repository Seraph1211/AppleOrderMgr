import { useState } from 'react';
import { ChevronDown, X, Search } from 'lucide-react';

import { STATUS } from './inventoryPresentation';

/** 统一状态徽章。 */
export function Status({ value }) {
  return (
    <span
      className={`badge whitespace-nowrap ${['in_stock', 'complete', 'normal', 'accepted'].includes(value) ? 'bg-green-100 text-green-700' : ['error', 'failed', 'manual_required'].includes(value) ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}
    >
      {STATUS[value] || value || '—'}
    </span>
  );
}
/** 支持触屏的多选菜单，不依赖鼠标悬停。 */
export function MultiSelect({ label, options, values = [], onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  return (
    <div className="relative min-w-0">
      <button
        type="button"
        className="btn inline-flex items-center justify-center gap-2 btn-secondary w-full min-h-[44px] justify-between"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
        {values.length ? ` (${values.length})` : ''}
        <ChevronDown className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute z-20 top-full mt-1 left-0 w-full min-w-[180px] rounded-lg bg-white border border-gray-200 shadow-lg p-2">
          <div className="flex gap-1">
            <input
              className="input min-w-0"
              aria-label={`搜索${label}`}
              placeholder="搜索"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <button
              className="btn inline-flex items-center justify-center gap-2 btn-secondary p-2"
              aria-label={`关闭${label}`}
              onClick={() => setOpen(false)}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto mt-2" role="group" aria-label={label}>
            {options
              .filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
              .map(option => (
                <label
                  key={option.value}
                  className="flex items-center gap-2 min-h-[44px] px-2 hover:bg-gray-50 text-sm cursor-pointer"
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
                  {option.label}
                </label>
              ))}
          </div>
          <button className="text-sm text-primary px-2 min-h-[44px]" onClick={() => onChange([])}>
            清空选择
          </button>
        </div>
      )}
    </div>
  );
}
/** 全国共用城市、门店与规格过滤。 */
export function InventoryFilters({ catalog, filters, onChange, onApply }) {
  const uniq = (items, field) =>
    [...new Set(items.map(r => r[field]).filter(Boolean))]
      .sort()
      .map(v => ({ value: v, label: v }));
  const set = (key, value) => onChange({ ...filters, [key]: value });
  const options = {
    cities: uniq(catalog.stores, 'city'),
    stores: catalog.stores
      .filter(s => !filters.cities?.length || filters.cities.includes(s.city))
      .map(s => ({ value: s.storeCode, label: `${s.city} · ${s.storeName}` })),
    models: uniq(catalog.products, 'model'),
    capacities: uniq(catalog.products, 'capacity'),
    colors: uniq(catalog.products, 'color'),
  };
  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-4 space-y-3"
      aria-label="库存筛选"
    >
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        {Object.entries({
          cities: '城市',
          stores: '门店',
          models: '型号',
          capacities: '容量',
          colors: '颜色',
        }).map(([key, label]) => (
          <MultiSelect
            key={key}
            label={label}
            options={options[key]}
            values={filters[key]}
            onChange={value => set(key, value)}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <button
          className="btn inline-flex items-center justify-center gap-2 btn-primary min-h-[44px]"
          onClick={onApply}
        >
          <Search className="w-4 h-4" />
          应用筛选
        </button>
        <button
          className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
          onClick={() => onChange({})}
        >
          重置选择
        </button>
        <span className="text-xs text-gray-500">个人筛选不改变全国采集范围</span>
      </div>
    </section>
  );
}
/** 有边界的服务器分页。 */
export function Pager({ data, onChange, busy }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm text-gray-600">
      <span>
        共 {data?.total || 0} 条 · 第 {data?.page || 1} 页
      </span>
      <div className="flex gap-2">
        <button
          className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
          disabled={busy || !data || data.page <= 1}
          onClick={() => onChange(data.page - 1)}
        >
          上一页
        </button>
        <button
          className="btn inline-flex items-center justify-center gap-2 btn-secondary min-h-[44px]"
          disabled={busy || !data || data.page * data.pageSize >= data.total}
          onClick={() => onChange(data.page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
/** 横向滚动表格不撑破手机页面。 */
export function Table({ headers, children, empty, label = '数据表格' }) {
  return (
    <div
      className="overflow-x-auto rounded-lg border border-gray-200 bg-white"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <table className="min-w-full text-sm text-left">
        <thead className="bg-gray-50 text-gray-500">
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="px-3 py-3 whitespace-nowrap font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {empty ? (
            <tr>
              <td colSpan={headers.length} className="px-4 py-10 text-center text-gray-500">
                当前条件下暂无记录
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}
