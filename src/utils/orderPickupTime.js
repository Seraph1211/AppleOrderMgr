const PICKUP_TIME_PATTERN =
  /(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(?:的\s*)?(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})/gu;
const MONTH_GROUP = 2;
const DAY_GROUP = 3;
const START_TIME_GROUP = 4;
const END_TIME_GROUP = 5;
const PADDED_PART_LENGTH = 2;
const MAX_HOUR = 23;
const MAX_MINUTE = 59;

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
  const hour = Number(match[1]);
  const minute = Number(match[MONTH_GROUP]);
  if (hour > MAX_HOUR || minute > MAX_MINUTE) return null;
  return `${String(hour).padStart(PADDED_PART_LENGTH, '0')}:${String(minute).padStart(
    PADDED_PART_LENGTH,
    '0'
  )}`;
}

/**
 * 从官网履约提示原文提取预约取货日期和时间段。
 * @param {string|null|undefined} message - 官网履约提示原文
 * @returns {string|null} 去除星期和说明文字后的预约时间
 */
function formatPickupTime(message) {
  if (typeof message !== 'string' || !message.trim()) return null;
  const values = [];
  for (const match of message.matchAll(PICKUP_TIME_PATTERN)) {
    const year = Number(match[1]);
    const month = Number(match[MONTH_GROUP]);
    const day = Number(match[DAY_GROUP]);
    const startTime = normalizeTime(match[START_TIME_GROUP]);
    const endTime = normalizeTime(match[END_TIME_GROUP]);
    if (!isValidDate(year, month, day) || !startTime || !endTime) continue;
    const date = `${year}/${String(month).padStart(PADDED_PART_LENGTH, '0')}/${String(day).padStart(
      PADDED_PART_LENGTH,
      '0'
    )}`;
    const value = `${date} ${startTime} – ${endTime}`;
    if (!values.includes(value)) values.push(value);
  }
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
  const year = Number(match[1]);
  const month = Number(match[MONTH_GROUP]);
  const day = Number(match[DAY_GROUP]);
  if (!isValidDate(year, month, day)) return null;
  return `${match[1]}/${match[MONTH_GROUP]}/${match[DAY_GROUP]}`;
}

module.exports = { formatPickupTime, normalizePickupDate };
