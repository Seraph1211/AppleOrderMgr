import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { addDays, addMonths, format, parseISO, startOfMonth, startOfWeek } from 'date-fns';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  DATE_FILTER_MODES,
  describeDateRange,
  getBeijingToday,
  isCalendarDate,
  resolveDateFilter,
} from '../utils/dateFilter';
import './dateRangeFilter.css';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 订单页日期筛选：按钮摘要、日历草稿、显式应用；复用既有起止日期 API。
 * @param {Object} props - 日期边界、标题、无障碍前缀与提交回调。
 * @returns {JSX.Element} 日期筛选按钮及浮层。
 */
export default function DateRangeFilter({
  dateFrom = '',
  dateTo = '',
  onChange,
  label = '下单日期',
  ariaPrefix = '下单',
  hint = '按北京时间筛选，结束日期包含当天',
}) {
  const id = useId();
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const modeRef = useRef(null);
  const appliedChoice = useRef(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('between');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [endpoint, setEndpoint] = useState('from');
  const today = getBeijingToday();
  const [month, setMonth] = useState(() => startOfMonth(parseISO(today)));
  const [focusedDay, setFocusedDay] = useState(today);
  const [position, setPosition] = useState({ top: 12, left: 12 });
  const range = resolveDateFilter(mode, from, to);
  const selected = Boolean(dateFrom || dateTo);

  function closePanel() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function openPanel() {
    const saved = appliedChoice.current;
    const matching = saved && saved.dateFrom === dateFrom && saved.dateTo === dateTo;
    const nextMode = matching ? saved.mode : dateFrom && dateFrom === dateTo ? 'on' : 'between';
    const nextFrom = matching ? saved.from : dateFrom;
    const nextTo = matching ? saved.to : dateTo;
    const initialDate = nextFrom || nextTo || today;
    setMode(nextMode);
    setFrom(nextFrom);
    setTo(nextTo);
    setEndpoint('from');
    setMonth(startOfMonth(parseISO(initialDate)));
    setFocusedDay(initialDate);
    setOpen(true);
  }

  useLayoutEffect(() => {
    if (!open) return undefined;
    function positionPanel() {
      const button = triggerRef.current.getBoundingClientRect();
      const panel = panelRef.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const height = viewport?.height || window.innerHeight;
      const offsetTop = viewport?.offsetTop || 0;
      const below = button.bottom + 8;
      const top =
        below + panel.height <= height + offsetTop - 12
          ? below
          : Math.max(offsetTop + 12, button.top - panel.height - 8);
      setPosition({
        top,
        left: Math.max(12, Math.min(button.left, window.innerWidth - panel.width - 12)),
      });
    }
    positionPanel();
    const observer = new ResizeObserver(positionPanel);
    observer.observe(panelRef.current);
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
    window.visualViewport?.addEventListener('resize', positionPanel);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', positionPanel);
      window.removeEventListener('scroll', positionPanel, true);
      window.visualViewport?.removeEventListener('resize', positionPanel);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    modeRef.current?.focus();
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

  function applyRange() {
    if (!range) return;
    appliedChoice.current = { ...range, mode, from, to };
    onChange(range);
    closePanel();
  }

  function pickDate(value) {
    setFocusedDay(value);
    setMonth(startOfMonth(parseISO(value)));
    if (mode !== 'between') {
      setFrom(value);
    } else if (endpoint === 'from') {
      setFrom(value);
      if (to && value > to) setTo('');
      setEndpoint('to');
    } else if (from && value < from) {
      setTo(from);
      setFrom(value);
      setEndpoint('from');
    } else {
      setTo(value);
      setEndpoint('from');
    }
  }

  function moveMonth(amount) {
    const next = addMonths(month, amount);
    if (!isCalendarDate(format(next, 'yyyy-MM-dd'))) return;
    setMonth(next);
    setFocusedDay(format(next, 'yyyy-MM-dd'));
  }

  function calendarKeyDown(event, value) {
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next;
    if (event.key in steps) next = addDays(parseISO(value), steps[event.key]);
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      next = addMonths(parseISO(value), event.key === 'PageUp' ? -1 : 1);
    } else return;
    event.preventDefault();
    const nextValue = format(next, 'yyyy-MM-dd');
    if (!isCalendarDate(nextValue)) return;
    setMonth(startOfMonth(next));
    setFocusedDay(nextValue);
    requestAnimationFrame(() =>
      panelRef.current?.querySelector(`[data-date="${nextValue}"]`)?.focus()
    );
  }

  function panelKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    }
    if (event.key === 'Tab') {
      const controls = [
        ...panelRef.current.querySelectorAll('button:not(:disabled), input, select'),
      ].filter(element => element.tabIndex >= 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  const firstDay = startOfWeek(month, { weekStartsOn: 1 });
  const days = Array.from({ length: 42 }, (_, index) => addDays(firstDay, index));

  return (
    <div className="date-range-filter">
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-secondary date-range-trigger ${selected ? 'is-selected' : ''}`}
        aria-label={`${label}：${describeDateRange(dateFrom, dateTo)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? closePanel() : openPanel())}
      >
        <CalendarDays className="w-4 h-4 shrink-0" />
        <span className="date-range-trigger-label">{label}</span>
        <span className="date-range-summary">{describeDateRange(dateFrom, dateTo)}</span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="dialog"
            aria-label={`${label}选择`}
            className="date-range-popover"
            style={position}
            onKeyDown={panelKeyDown}
          >
            <div className="date-range-toolbar">
              <select
                ref={modeRef}
                aria-label={`${ariaPrefix}日期条件`}
                className="input"
                value={mode}
                onChange={event => {
                  setMode(event.target.value);
                  setEndpoint('from');
                }}
              >
                {DATE_FILTER_MODES.map(([value, title]) => (
                  <option key={value} value={value}>
                    {title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn text-red-600 hover:bg-red-50"
                disabled={!selected && !from && !to}
                onClick={() => {
                  appliedChoice.current = null;
                  onChange({ dateFrom: '', dateTo: '' });
                  closePanel();
                }}
              >
                清空
              </button>
              <button
                type="button"
                className="btn date-range-icon"
                aria-label="关闭日期选择"
                onClick={closePanel}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className={`date-range-inputs ${mode === 'between' ? 'has-range' : ''}`}>
              <label className={endpoint === 'from' ? 'is-active' : ''}>
                <span>{mode === 'between' ? '开始日期' : '选择日期'}</span>
                <input
                  className="input"
                  type="date"
                  aria-label={`${ariaPrefix}开始日期`}
                  value={from}
                  min="1000-01-01"
                  max="9999-12-31"
                  onFocus={() => setEndpoint('from')}
                  onChange={event => {
                    setFrom(event.target.value);
                    if (isCalendarDate(event.target.value)) {
                      setMonth(startOfMonth(parseISO(event.target.value)));
                      setFocusedDay(event.target.value);
                    }
                  }}
                />
              </label>
              {mode === 'between' && (
                <label className={endpoint === 'to' ? 'is-active' : ''}>
                  <span>结束日期（含当天）</span>
                  <input
                    className="input"
                    type="date"
                    aria-label={`${ariaPrefix}结束日期`}
                    value={to}
                    min="1000-01-01"
                    max="9999-12-31"
                    onFocus={() => setEndpoint('to')}
                    onChange={event => {
                      setTo(event.target.value);
                      if (isCalendarDate(event.target.value)) {
                        setMonth(startOfMonth(parseISO(event.target.value)));
                        setFocusedDay(event.target.value);
                      }
                    }}
                  />
                </label>
              )}
            </div>
            <div className="date-range-month">
              <span aria-live="polite" className="font-semibold text-gray-900">
                {format(month, 'yyyy 年 M 月')}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  className="btn date-range-icon"
                  aria-label="上个月"
                  onClick={() => moveMonth(-1)}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  className="btn date-range-icon"
                  aria-label="下个月"
                  onClick={() => moveMonth(1)}
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="date-range-calendar" role="group" aria-label={`${ariaPrefix}日历`}>
              {WEEKDAYS.map(day => (
                <span key={day} className="date-range-weekday">
                  {day}
                </span>
              ))}
              {days.map(day => {
                const value = format(day, 'yyyy-MM-dd');
                const isEdge = mode === 'between' ? value === from || value === to : value === from;
                const isInside =
                  range?.dateFrom &&
                  range?.dateTo &&
                  value > range.dateFrom &&
                  value < range.dateTo;
                return (
                  <button
                    key={value}
                    type="button"
                    data-date={value}
                    aria-label={value}
                    aria-pressed={Boolean(isEdge || isInside)}
                    aria-current={value === today ? 'date' : undefined}
                    disabled={!isCalendarDate(value)}
                    tabIndex={value === focusedDay ? 0 : -1}
                    className={`date-range-day ${day.getMonth() !== month.getMonth() ? 'is-outside' : ''} ${isEdge ? 'is-edge' : ''} ${isInside ? 'is-inside' : ''} ${value === today ? 'is-today' : ''}`}
                    onKeyDown={event => calendarKeyDown(event, value)}
                    onClick={() => pickDate(value)}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
            <p className="date-range-hint" aria-live="polite">
              {mode === 'between'
                ? `请选择${endpoint === 'from' ? '开始' : '结束'}日期，也可只填一端`
                : '选择日期后点击应用'}
            </p>
            {mode === 'between' && from && to && from > to && (
              <p role="alert" className="text-xs text-red-600 mb-2">
                开始日期不能晚于结束日期
              </p>
            )}
            <div className="date-range-footer">
              <p>{hint}</p>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn btn-secondary" onClick={closePanel}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!range}
                  onClick={applyRange}
                >
                  应用
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
