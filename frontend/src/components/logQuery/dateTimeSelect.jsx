import usePopupPosition from './usePopupPosition';
import { validateLogRange } from '../../utils/monitorLogRange';
import { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';

const dateFromKey = key => new Date(`${key}T12:00:00Z`);
const keyFromDate = date => date.toISOString().slice(0, 10);
const monthFromKey = key =>
  new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1, 12));
const normalizeTime = value => (value.length === 5 ? `${value}:00` : value);

/** 一个端点内同时编辑日期与秒级时间，独立持有自己的日历月份。 */
function DateTimeEndpoint({ kind, date, time, minDate, maxDate, onDateChange, onTimeChange }) {
  const start = kind === 'start';
  const label = start ? '开始' : '结束';
  const [month, setMonth] = useState(() => monthFromKey(date));
  const [focusKey, setFocusKey] = useState(date);
  const root = useRef(null);
  useEffect(() => {
    if (!date) return;
    setMonth(monthFromKey(date));
    setFocusKey(date);
  }, [date]);
  function moveMonth(offset) {
    const next = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + offset, 1, 12));
    setMonth(next);
    const first = keyFromDate(next);
    setFocusKey(first < minDate ? minDate : first > maxDate ? maxDate : first);
  }
  function keyboardDay(event) {
    const shifts = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (!(event.key in shifts) || !event.target.dataset.date) return;
    event.preventDefault();
    const next = dateFromKey(event.target.dataset.date);
    next.setUTCDate(next.getUTCDate() + shifts[event.key]);
    const key = keyFromDate(next);
    if (key < minDate || key > maxDate) return;
    setFocusKey(key);
    setMonth(monthFromKey(key));
    requestAnimationFrame(() => root.current?.querySelector(`[data-date="${key}"]`)?.focus());
  }
  const offset = (month.getUTCDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, index) => {
    const value = new Date(month);
    value.setUTCDate(1 - offset + index);
    return { value, key: keyFromDate(value) };
  });
  return (
    <section
      ref={root}
      role="group"
      aria-label={`${label}日期时间`}
      data-endpoint={kind}
      className="logs-datetime-endpoint"
    >
      <h3>{start ? '开始日期时间' : '结束日期时间'}</h3>
      <div className="logs-endpoint-value">
        <input
          className="input"
          type="date"
          aria-label={`${label}日期`}
          value={date}
          min={minDate}
          max={maxDate}
          onChange={event => {
            const next = event.target.value;
            onDateChange(next);
          }}
        />
        <input
          className="input"
          type="time"
          step="1"
          aria-label={`${label}时间`}
          value={time || (start ? '00:00:00' : '23:59:59')}
          onChange={event => onTimeChange(event.target.value)}
        />
      </div>
      <div className="logs-calendar-heading">
        <strong>
          {month.getUTCFullYear()}年{month.getUTCMonth() + 1}月
        </strong>
        <div>
          <button
            type="button"
            aria-label="上个月"
            disabled={keyFromDate(month).slice(0, 7) <= minDate.slice(0, 7)}
            onClick={() => moveMonth(-1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="下个月"
            disabled={keyFromDate(month).slice(0, 7) >= maxDate.slice(0, 7)}
            onClick={() => moveMonth(1)}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="logs-calendar-week" aria-hidden="true">
        {['一', '二', '三', '四', '五', '六', '日'].map(day => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div
        className="logs-calendar-days"
        role="group"
        aria-label={`${label}日期日历`}
        onKeyDown={keyboardDay}
      >
        {cells.map(cell => (
          <button
            key={cell.key}
            type="button"
            data-date={cell.key}
            data-outside={cell.value.getUTCMonth() !== month.getUTCMonth()}
            aria-label={cell.key}
            aria-pressed={cell.key === date}
            tabIndex={cell.key === focusKey ? 0 : -1}
            disabled={cell.key < minDate || cell.key > maxDate}
            onClick={() => onDateChange(cell.key)}
          >
            {cell.value.getUTCDate()}
          </button>
        ))}
      </div>
    </section>
  );
}

/** 开始与结束各自一组完整日期时间，确认后进入查询草稿。 */
export default function MonitorLogDateTimeSelect({
  date,
  endDate = date,
  fromTime,
  toTime,
  minDate,
  maxDate,
  onChange,
}) {
  const [open, setOpen] = useState(false);
  const [startDate, setStartDate] = useState(date);
  const [finishDate, setFinishDate] = useState(endDate);
  const [start, setStart] = useState(fromTime);
  const [end, setEnd] = useState(toTime);
  const root = useRef(null);
  const trigger = useRef(null);
  const id = useId();
  const position = usePopupPosition(open, trigger, 620);
  useEffect(() => {
    if (!open) return undefined;
    function outside(event) {
      if (!root.current?.contains(event.target)) close();
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  function show() {
    setStartDate(date);
    setFinishDate(endDate);
    setStart(fromTime);
    setEnd(toTime);
    setOpen(true);
    requestAnimationFrame(() =>
      root.current?.querySelector('[data-endpoint="start"] input')?.focus({ preventScroll: true })
    );
  }
  const invalid = validateLogRange(
    `${startDate}T${normalizeTime(start || '00:00:00')}`,
    `${finishDate}T${normalizeTime(end || '23:59:59')}`,
    minDate,
    maxDate
  );
  const custom = Boolean(fromTime || toTime);
  const crossDay = date !== endDate;
  function apply() {
    if (!invalid) {
      onChange(startDate, finishDate, normalizeTime(start || ''), normalizeTime(end || ''));
      close();
    }
  }
  function shortcut(days) {
    if (!finishDate) return;
    const first = dateFromKey(finishDate);
    first.setUTCDate(first.getUTCDate() - days + 1);
    const key = keyFromDate(first);
    setStartDate(key < minDate ? minDate : key);
    setStart('');
    setEnd('');
  }
  return (
    <div
      ref={root}
      className="logs-datetime-select"
      onBlur={event => {
        if (open && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      data-custom={custom}
      data-range={crossDay}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
          event.preventDefault();
          apply();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="input logs-datetime-trigger"
        aria-label={`日志日期与时间：${date} ${fromTime || '00:00:00'} 至 ${endDate} ${toTime || '23:59:59'} 北京时间`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={`${date} ${fromTime || '00:00:00'} — ${endDate} ${toTime || '23:59:59'}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            show();
            requestAnimationFrame(() =>
              root.current?.querySelector('[data-endpoint="start"] input')?.focus()
            );
          }
        }}
      >
        <CalendarDays className="h-4 w-4" aria-hidden="true" />
        {crossDay ? (
          <span className="logs-range-summary">
            {date.replaceAll('-', '/')} {fromTime || '00:00:00'} —{' '}
            {(date.slice(0, 4) === endDate.slice(0, 4) ? endDate.slice(5) : endDate).replaceAll(
              '-',
              '/'
            )}{' '}
            {toTime || '23:59:59'}
          </span>
        ) : (
          <>
            <span className="logs-datetime-date">{date.replaceAll('-', '/')}</span>
            <span className="logs-datetime-divider" aria-hidden="true" />
            <span className="logs-datetime-time">
              {custom ? `${fromTime || '00:00:00'}—${toTime || '23:59:59'}` : '全天'}
            </span>
          </>
        )}
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label="选择日志日期与时间"
          className="logs-datetime-popover logs-paired-picker"
          style={position}
        >
          <header>
            <span>
              日期时间范围 <small>北京时间</small>
            </span>
            <button type="button" aria-label="关闭日期与时间" onClick={close}>
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="logs-endpoint-panels">
            <DateTimeEndpoint
              kind="start"
              date={startDate}
              time={start}
              minDate={minDate}
              maxDate={maxDate}
              onDateChange={setStartDate}
              onTimeChange={setStart}
            />
            <DateTimeEndpoint
              kind="end"
              date={finishDate}
              time={end}
              minDate={minDate}
              maxDate={maxDate}
              onDateChange={setFinishDate}
              onTimeChange={setEnd}
            />
          </div>
          {invalid && (
            <p role="alert" className="logs-paired-error">
              {invalid}
            </p>
          )}
          <footer>
            <div className="logs-endpoint-shortcuts">
              <button type="button" title="以结束日期为基准" onClick={() => shortcut(1)}>
                当天
              </button>
              <button type="button" title="以结束日期为基准" onClick={() => shortcut(3)}>
                近3天
              </button>
              <button type="button" title="以结束日期为基准" onClick={() => shortcut(7)}>
                近7天
              </button>
            </div>
            <div className="logs-paired-actions">
              <button type="button" className="logs-datetime-cancel" onClick={close}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={Boolean(invalid)}
                onClick={apply}
              >
                确定
              </button>
            </div>
          </footer>
        </div>
      )}
    </div>
  );
}
