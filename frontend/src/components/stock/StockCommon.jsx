import useModalScrollLock from '../useModalScrollLock';
import ResponsiveSelect from '../responsiveSelect';
import { useEffect, useId, useRef } from 'react';
import { X, RefreshCw, Plus, Trash2 } from 'lucide-react';
import { STOCK_LABELS } from './stockHelpers';
import './stock.css';

/** 可访问、可滚动的表单容器，支持小屏与短视口。 */
export function StockModal({ title, children, onClose, busy = false, wide = false }) {
  useModalScrollLock();
  const titleId = useId();
  const root = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus?.({ preventScroll: true });
    };
  }, []);
  const keyDown = event => {
    if (event.key === 'Escape' && !busy) {
      event.stopPropagation();
      closeRef.current();
    }
    if (event.key !== 'Tab') return;
    const elements = [
      ...root.current.querySelectorAll(
        'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]'
      ),
    ].filter(node => node.offsetParent !== null);
    if (!elements.length) {
      event.preventDefault();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === root.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/40 sm:p-4">
      <section
        ref={root}
        tabIndex={-1}
        onKeyDown={keyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`stock-modal overflow-hidden flex h-[100dvh] w-full min-w-0 flex-col bg-white sm:h-auto sm:max-h-[92dvh] sm:rounded-xl ${wide ? 'sm:max-w-5xl' : 'sm:max-w-2xl'}`}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b p-4">
          <h2 id={titleId} className="text-lg font-semibold text-gray-900">
            {title}
          </h2>
          <button
            type="button"
            aria-label={`关闭${title}`}
            className="btn btn-secondary min-h-[44px] min-w-[44px]"
            onClick={onClose}
            disabled={busy}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="stock-dialog-scroll min-w-0 min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </section>
    </div>
  );
}

/** 错误和加载反馈。 */
export function StockFeedback({ loading, error, onRetry }) {
  if (loading)
    return (
      <p role="status" className="py-8 text-center text-gray-500">
        正在加载…
      </p>
    );
  return error ? (
    <div
      role="alert"
      className="my-3 space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
    >
      <p className="break-words">{error}</p>
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" />
          重新加载
        </button>
      )}
    </div>
  ) : null;
}

/** 业务状态徽章。 */
export function StockBadge({ value }) {
  return (
    <span
      className={`badge ${['sold', 'shipped', 'received', 'posted', 'confirmed'].includes(value) ? 'badge-success' : ['cancelled', 'voided'].includes(value) ? 'badge-error' : 'badge-info'}`}
    >
      {STOCK_LABELS[value] || value || '—'}
    </span>
  );
}

/** 表格空态与窄屏横向滚动封装。 */
export function StockTable({
  columns,
  items = [],
  rowKey = 'id',
  empty = '暂无符合条件的记录',
  onRow,
  mobileFields = false,
  tableClassName = '',
}) {
  return (
    <div className={`stock-table-wrap ${mobileFields ? 'stock-mobile-fields' : ''}`}>
      <table className={`stock-table ${tableClassName}`}>
        <thead>
          <tr>
            {columns.map(column => (
              <th key={column.key} className={column.mobileHidden ? 'stock-hide-mobile' : ''}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={item[rowKey] || index} onDoubleClick={() => onRow?.(item)}>
              {columns.map(column => (
                <td
                  key={column.key}
                  data-label={typeof column.title === 'string' ? column.title : undefined}
                  className={`${column.mobileHidden ? 'stock-hide-mobile ' : ''}${column.className || ''}`}
                >
                  {column.render ? column.render(item) : (item[column.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
          {!items.length && (
            <tr>
              <td colSpan={columns.length} className="py-10 text-center text-gray-500">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** 标签与表单元素绑定，嵌套数组同样提供可访问名称。 */
export function StockField({ label, hint, children }) {
  return (
    <label className="block min-w-0 space-y-1 text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-5 text-gray-500">{hint}</span>}
    </label>
  );
}

/** 声明式字段，用中文标签维护业务资料及更正清单。 */
export function StockFields({ fields, value, onChange, disabled = false, prefix = '' }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      {fields
        .filter(field => !field.hidden)
        .map(field => {
          const current = value[field.key] ?? field.defaultValue ?? '';
          const label = `${prefix}${field.label}`;
          const change = next => onChange({ ...value, [field.key]: next });
          if (field.type === 'array')
            return (
              <fieldset
                key={field.key}
                className="col-span-full min-w-0 space-y-3 rounded-lg border p-3"
              >
                <legend className="px-1 text-sm font-medium">{field.label}</legend>
                {(current || []).map((row, index) => (
                  <div key={index} className="space-y-2 border-b pb-3">
                    <StockFields
                      fields={field.fields}
                      value={row}
                      disabled={disabled}
                      prefix={`${field.label} ${index + 1} `}
                      onChange={next =>
                        change(current.map((item, idx) => (idx === index ? next : item)))
                      }
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={disabled}
                      onClick={() => change(current.filter((_, idx) => idx !== index))}
                    >
                      <Trash2 className="h-4 w-4" />
                      移除第 {index + 1} 项
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={disabled || current.length >= (field.max || 100)}
                  onClick={() => change([...(current || []), { ...(field.empty || {}) }])}
                >
                  <Plus className="h-4 w-4" />
                  添加{field.label}
                </button>
              </fieldset>
            );
          if (field.type === 'checkbox')
            return (
              <label key={field.key} className="flex min-h-[44px] items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(current)}
                  disabled={disabled}
                  onChange={event => change(event.target.checked)}
                />
                {label}
              </label>
            );
          return (
            <StockField key={field.key} label={label} hint={field.hint}>
              {field.type === 'select' ? (
                <ResponsiveSelect
                  className="input"
                  required={field.required}
                  value={current}
                  disabled={disabled || field.disabled}
                  onChange={event => change(event.target.value)}
                >
                  <option value="">{field.placeholder || '请选择'}</option>
                  {(field.options || []).map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </ResponsiveSelect>
              ) : field.type === 'textarea' ? (
                <textarea
                  className="input"
                  value={current}
                  required={field.required}
                  disabled={disabled}
                  rows={3}
                  onChange={event => change(event.target.value)}
                />
              ) : (
                <input
                  className="input"
                  type={field.type || 'text'}
                  inputMode={field.money ? 'decimal' : undefined}
                  value={current}
                  required={field.required}
                  disabled={disabled || field.disabled}
                  min={field.min}
                  max={field.max}
                  step={field.step ?? (field.type === 'datetime-local' ? 1 : undefined)}
                  maxLength={field.maxLength || 500}
                  placeholder={field.placeholder}
                  onChange={event => change(event.target.value)}
                />
              )}
            </StockField>
          );
        })}
    </div>
  );
}

/** 标准列表分页。 */
export function StockPager({ page, pageSize, total, onPage, onSize }) {
  return (
    <div className="stock-pagination flex flex-wrap items-center justify-between gap-2 py-3 text-sm text-gray-500">
      <span>
        共 {total || 0} 条 · 第 {page} / {Math.max(1, Math.ceil((total || 0) / pageSize))} 页
      </span>
      <div className="flex items-center gap-2">
        {onSize && (
          <ResponsiveSelect
            aria-label="每页条数"
            className="input"
            value={pageSize}
            onChange={event => onSize(Number(event.target.value))}
          >
            {[20, 50, 100].map(size => (
              <option key={size} value={size}>
                {size} 条
              </option>
            ))}
          </ResponsiveSelect>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={page * pageSize >= (total || 0)}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
