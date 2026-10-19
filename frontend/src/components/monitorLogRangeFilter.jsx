import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronDown, X } from 'lucide-react';
import {
  describeLogRange,
  logDay,
  logRangePreset,
  normalizeLogDateTime,
  validateLogRange,
} from '../utils/monitorLogRange';
import './monitorLogs.css';

/** 日志起止时间草稿面板，确认后仍需在查询表单点击查询。 */
export default function MonitorLogRangeFilter({ startAt, endAt, first, onChange }) {
  const id = useId();
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState({ startAt, endAt });
  const [position, setPosition] = useState({ top: 12, left: 12 });
  const earliest = first || logDay(-89);
  const latest = logDay();
  const error = validateLogRange(range.startAt, range.endAt, earliest, latest);

  function close() {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (!open) return undefined;
    function positionPanel() {
      const button = triggerRef.current.getBoundingClientRect();
      const panel = panelRef.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const height = viewport?.height || window.innerHeight;
      const topOffset = viewport?.offsetTop || 0;
      const leftOffset = viewport?.offsetLeft || 0;
      const width = viewport?.width || window.innerWidth;
      const below = button.bottom + 8;
      setPosition({
        top: Math.max(topOffset + 12, Math.min(below, topOffset + height - panel.height - 12)),
        left: Math.max(
          leftOffset + 12,
          Math.min(button.left, leftOffset + width - panel.width - 12)
        ),
      });
    }
    positionPanel();
    const observer = new ResizeObserver(positionPanel);
    observer.observe(panelRef.current);
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
    window.visualViewport?.addEventListener('resize', positionPanel);
    window.visualViewport?.addEventListener('scroll', positionPanel);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', positionPanel);
      window.removeEventListener('scroll', positionPanel, true);
      window.visualViewport?.removeEventListener('resize', positionPanel);
      window.visualViewport?.removeEventListener('scroll', positionPanel);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.focus({ preventScroll: true });
    function dismiss(event) {
      if (
        !panelRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  function onPanelKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key !== 'Tab') return;
    const controls = [...panelRef.current.querySelectorAll('button:not(:disabled), input')];
    const firstControl = controls[0];
    const lastControl = controls.at(-1);
    if (
      event.shiftKey &&
      (document.activeElement === firstControl || document.activeElement === panelRef.current)
    ) {
      event.preventDefault();
      lastControl?.focus();
    } else if (!event.shiftKey && document.activeElement === lastControl) {
      event.preventDefault();
      firstControl?.focus();
    }
  }

  return (
    <div className="monitor-log-range">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-secondary monitor-log-range-trigger"
        aria-label={`日志时间范围：${describeLogRange(startAt, endAt)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) close();
          else {
            setRange({ startAt, endAt });
            setOpen(true);
          }
        }}
      >
        <CalendarDays className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 whitespace-normal text-left">
          {describeLogRange(startAt, endAt)}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-label="日志时间范围选择"
            className="monitor-log-range-popover"
            style={position}
            onKeyDown={onPanelKey}
          >
            <div className="mb-4 flex items-center justify-between gap-2">
              <div>
                <h3 className="font-semibold text-gray-900">日志时间范围</h3>
                <p className="mt-1 text-xs text-gray-500">北京时间 · 可跨天查询</p>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                aria-label="关闭时间范围选择"
                onClick={close}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mb-4 flex flex-wrap gap-2" aria-label="常用日志时间范围">
              {[
                ['today', '今天'],
                ['yesterday', '昨天'],
                ['last24', '最近24小时'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setRange(logRangePreset(key))}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid min-w-0 gap-3">
              {[
                ['startAt', '开始日期和时间'],
                ['endAt', '结束日期和时间'],
              ].map(([field, label]) => (
                <label key={field} className="block min-w-0 text-sm text-gray-600">
                  <span>{label}</span>
                  <input
                    type="datetime-local"
                    step="1"
                    required
                    min={`${earliest}T00:00:00`}
                    max={`${latest}T23:59:59`}
                    aria-label={label}
                    className="input mt-1 block w-full min-w-0 text-base sm:text-sm"
                    value={range[field]}
                    onChange={event =>
                      setRange(value => ({ ...value, [field]: event.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {error}
              </p>
            )}
            <div className="mt-4 border-t border-gray-100 pt-3">
              <p className="mb-3 text-xs leading-5 text-gray-500">
                包含起止秒；修改后点击页面“查询”加载日志。
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn btn-secondary" onClick={close}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={Boolean(error)}
                  onClick={() => {
                    onChange({
                      startAt: normalizeLogDateTime(range.startAt),
                      endAt: normalizeLogDateTime(range.endAt),
                    });
                    close();
                  }}
                >
                  应用时间范围
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
