/** 日期选择方式；提交时仍使用现有包含边界的起止日期契约。 */
export const DATE_FILTER_MODES = [
  ['between', '日期范围'],
  ['on', '指定日期'],
  ['before', '早于'],
  ['after', '晚于'],
  ['onOrBefore', '当天及之前'],
  ['onOrAfter', '当天及之后'],
];

/** 校验日历日期，避免非法日期被 Date 自动归一化。 */
export function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1000-01-01') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 按公历移动天数，不受浏览器时区和夏令时影响。 */
export function shiftCalendarDate(value, days) {
  if (!isCalendarDate(value)) return '';
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  const result = date.toISOString().slice(0, 10);
  return isCalendarDate(result) ? result : '';
}

/** 将日期选择转换为 API 的包含边界范围，非法草稿返回 null。 */
export function resolveDateFilter(mode, from, to) {
  if (!DATE_FILTER_MODES.some(([key]) => key === mode)) return null;
  if ((from && !isCalendarDate(from)) || (mode === 'between' && to && !isCalendarDate(to)))
    return null;
  if (mode === 'between') {
    if ((!from && !to) || (from && to && from > to)) return null;
    return { dateFrom: from, dateTo: to };
  }
  if (!from) return null;
  if (mode === 'on') return { dateFrom: from, dateTo: from };
  if (mode === 'onOrBefore') return { dateFrom: '', dateTo: from };
  if (mode === 'onOrAfter') return { dateFrom: from, dateTo: '' };
  const shifted = shiftCalendarDate(from, mode === 'before' ? -1 : 1);
  if (!shifted) return null;
  return mode === 'before' ? { dateFrom: '', dateTo: shifted } : { dateFrom: shifted, dateTo: '' };
}

/** 按北京时间取今天，作为未选日期时的日历初始月份。 */
export function getBeijingToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 已应用条件的紧凑摘要。 */
export function describeDateRange(from, to) {
  if (from && to) return from === to ? from : `${from} 至 ${to}`;
  if (from) return `${from} 起`;
  if (to) return `截至 ${to}`;
  return '不限日期';
}
