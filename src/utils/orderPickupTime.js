const PICKUP_TIME_PATTERN =
  /(\d{4}\/\d{1,2}\/\d{1,2}|今天|明天)\s*(?:的\s*)?(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})/gu;
const DATE_PART_GROUP = 1;
const START_TIME_GROUP = 2;
const END_TIME_GROUP = 3;
const YEAR_GROUP = 1;
const MONTH_GROUP = 2;
const DAY_GROUP = 3;
const HOUR_GROUP = 1;
const MINUTE_GROUP = 2;
const PADDED_PART_LENGTH = 2;
const MAX_HOUR = 23;
const MAX_MINUTE = 59;
const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

function isValidDate(year, month, day) {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function normalizeTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[HOUR_GROUP]);
  const minute = Number(match[MINUTE_GROUP]);
  if (hour > MAX_HOUR || minute > MAX_MINUTE) return null;
  return `${String(hour).padStart(PADDED_PART_LENGTH, '0')}:${String(minute).padStart(
    PADDED_PART_LENGTH,
    '0'
  )}`;
}

function formatDateParts(year, month, day) {
  return `${year}/${String(month).padStart(PADDED_PART_LENGTH, '0')}/${String(day).padStart(
    PADDED_PART_LENGTH,
    '0'
  )}`;
}

function parseAbsoluteDate(value) {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[YEAR_GROUP]);
  const month = Number(match[MONTH_GROUP]);
  const day = Number(match[DAY_GROUP]);
  return isValidDate(year, month, day) ? formatDateParts(year, month, day) : null;
}

function getShanghaiDateParts(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = type => Number(parts.find(part => part.type === type)?.value);
  const year = read('year');
  const month = read('month');
  const day = read('day');
  return isValidDate(year, month, day) ? { year, month, day } : null;
}

function resolvePickupDate(value, observedAt) {
  const absoluteDate = parseAbsoluteDate(value);
  if (absoluteDate) return absoluteDate;
  if (!['今天', '明天'].includes(value)) return null;
  const parts = getShanghaiDateParts(observedAt);
  if (!parts) return null;
  const offset = value === '明天' ? 1 : 0;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
  return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * 从官网履约提示原文提取预约取货安排。相对日期以官网观测时间为北京时间基准。
 * @param {string|null|undefined} message - 官网履约提示原文
 * @param {Date|string|null|undefined} observedAt - 官网观测时间
 * @returns {Array<{date: string, timeSlot: string, display: string}>} 去重后的预约安排
 */
function parsePickupSchedule(message, observedAt) {
  if (typeof message !== 'string' || !message.trim()) return [];
  const schedules = [];
  for (const match of message.matchAll(PICKUP_TIME_PATTERN)) {
    const date = resolvePickupDate(match[DATE_PART_GROUP], observedAt);
    const startTime = normalizeTime(match[START_TIME_GROUP]);
    const endTime = normalizeTime(match[END_TIME_GROUP]);
    if (!date || !startTime || !endTime) continue;
    const timeSlot = `${startTime} – ${endTime}`;
    const display = `${date} ${timeSlot}`;
    if (!schedules.some(item => item.display === display)) {
      schedules.push({ date, timeSlot, display });
    }
  }
  return schedules;
}

/**
 * 从官网履约提示原文提取预约取货日期和时间段。
 * @param {string|null|undefined} message - 官网履约提示原文
 * @param {Date|string|null|undefined} observedAt - 官网观测时间
 * @returns {string|null} 去除星期和说明文字后的预约时间
 */
function formatPickupTime(message, observedAt) {
  const values = parsePickupSchedule(message, observedAt).map(item => item.display);
  return values.join('；') || null;
}

/**
 * 从官网履约提示提取预约日期。
 * @param {string|null|undefined} message - 官网履约提示原文
 * @param {Date|string|null|undefined} observedAt - 官网观测时间
 * @returns {string|null} YYYY/MM/DD，多个日期以中文分号分隔
 */
function formatPickupDate(message, observedAt) {
  const values = [...new Set(parsePickupSchedule(message, observedAt).map(item => item.date))];
  return values.join('；') || null;
}

/**
 * 从官网履约提示提取预约时间段。
 * @param {string|null|undefined} message - 官网履约提示原文
 * @param {Date|string|null|undefined} observedAt - 官网观测时间
 * @returns {string|null} HH:mm – HH:mm，多个时段以中文分号分隔
 */
function formatPickupTimeSlot(message, observedAt) {
  const values = [...new Set(parsePickupSchedule(message, observedAt).map(item => item.timeSlot))];
  return values.join('；') || null;
}

/**
 * 校验 API 取货日期并转换为官网提示中的日期格式。
 * @param {unknown} value - YYYY-MM-DD 日期
 * @returns {string|null} YYYY/MM/DD；非法值返回 null
 */
function normalizePickupDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[YEAR_GROUP]);
  const month = Number(match[MONTH_GROUP]);
  const day = Number(match[DAY_GROUP]);
  if (!isValidDate(year, month, day)) return null;
  return `${match[YEAR_GROUP]}/${match[MONTH_GROUP]}/${match[DAY_GROUP]}`;
}

module.exports = {
  formatPickupDate,
  formatPickupTime,
  formatPickupTimeSlot,
  normalizePickupDate,
  parsePickupSchedule,
};
