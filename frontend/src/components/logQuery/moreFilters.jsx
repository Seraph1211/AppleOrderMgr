import usePopupPosition from './usePopupPosition';
import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';

/** 日志查询专属次要筛选；条件仍在主工具栏查询后应用。 */
export default function MonitorLogMoreFilters({ checked, onChange }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const position = usePopupPosition(open, trigger, 244);
  useEffect(() => {
    if (!open) return undefined;
    function outside(event) {
      if (!root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  return (
    <div
      ref={root}
      className="logs-more-filters"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="btn logs-more-trigger"
        aria-label="更多筛选"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <SlidersHorizontal className="h-4 w-4" />
        更多筛选{checked && <span className="logs-filter-count">1</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="更多筛选条件" className="logs-more-popover" style={position}>
          <header>
            <strong>更多筛选</strong>
            <button type="button" aria-label="关闭更多筛选" onClick={close}>
              <X className="h-4 w-4" />
            </button>
          </header>
          <label>
            <input
              type="checkbox"
              aria-label="仅查看未识别账号的日志"
              checked={checked}
              onChange={event => onChange(event.target.checked)}
            />
            仅未识别账号
          </label>
          <p>更改条件后，点击查询应用。</p>
          <footer>
            <button type="button" className="btn btn-secondary" onClick={close}>
              完成
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
