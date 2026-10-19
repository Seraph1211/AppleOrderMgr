const DAY_MS = 86400000;
const BEIJING_OFFSET_MS = 8 * 3600000;

/** 返回北京时间的日期，不依赖浏览器所在时区。 */
export function logDay(offset = 0, now = Date.now()) {
  return new Date(now + BEIJING_OFFSET_MS + offset * DAY_MS).toISOString().slice(0, 10);
}

/** 构造完整日期时间范围；最近 24 小时以当前北京时间为终点。 */
export function logRangePreset(preset = 'today', now = Date.now()) {
  if (preset === 'last24') {
    return {
      startAt: new Date(now + BEIJING_OFFSET_MS - DAY_MS).toISOString().slice(0, 19),
      endAt: new Date(now + BEIJING_OFFSET_MS).toISOString().slice(0, 19),
    };
  }
  const date = logDay(preset === 'yesterday' ? -1 : 0, now);
  return { startAt: `${date}T00:00:00`, endAt: `${date}T23:59:59` };
}

/** 规范浏览器省略的秒位，保持无时区的北京时间参数。 */
export function normalizeLogDateTime(value) {
  return value?.length === 16 ? `${value}:00` : value || '';
}

/** 验证完整起止时间和当前保留日期边界。 */
export function validateLogRange(startAt, endAt, first = logDay(-89), last = logDay()) {
  const start = normalizeLogDateTime(startAt);
  const end = normalizeLogDateTime(endAt);
  const validDateTime = value => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value;
  };
  if (!validDateTime(start) || !validDateTime(end)) return '请选择完整的开始和结束日期时间';
  if (start > end) return '开始时间不能晚于结束时间';
  if (start < `${first}T00:00:00` || end > `${last}T23:59:59`) {
    return `请选择 ${first} 至 ${last} 之间的日志`;
  }
  return '';
}

/** 完整展示起止时间；同一天省略重复日期。 */
export function describeLogRange(startAt, endAt) {
  if (!startAt || !endAt) return '选择日期与时间';
  const start = normalizeLogDateTime(startAt).replace('T', ' ');
  const end = normalizeLogDateTime(endAt);
  return `${start} — ${startAt.slice(0, 10) === endAt.slice(0, 10) ? end.slice(11) : end.replace('T', ' ')}`;
}
