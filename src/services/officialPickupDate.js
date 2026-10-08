const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CHINESE_DATE = /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日$/;
const PICKED_UP_DATE = /^已取货\s*(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日?$/;
const MAX_YEAR_SPAN = 20;

function dateValue(year, month, day) {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

/** 仅解析官网明确已取货文字，以官网下单日和本次观测日验证唯一年份。 */
function resolvePickupDate(raw, orderPlacedDate, observedAt = new Date()) {
  if (typeof raw !== 'string' || typeof orderPlacedDate !== 'string') return null;
  const pickup = raw.trim().match(PICKED_UP_DATE);
  const placed = orderPlacedDate.trim().match(CHINESE_DATE);
  const observed = new Date(observedAt);
  if (!pickup || !placed || !Number.isFinite(observed.getTime())) return null;
  const start = dateValue(Number(placed[1]), Number(placed[2]), Number(placed[3]));
  const end = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(observed);
  if (!start || !DATE_PATTERN.test(end) || start > end) return null;
  const firstYear = Number(placed[1]);
  const lastYear = Number(end.slice(0, 4));
  if (lastYear - firstYear > MAX_YEAR_SPAN) return null;
  const candidates = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    if (pickup[1] && Number(pickup[1]) !== year) continue;
    const value = dateValue(year, Number(pickup[2]), Number(pickup[3]));
    if (value && value >= start && value <= end) candidates.push(value);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** 从完整官网详情的逐项依据计算整单日期；不采用调用方直接传入的整单日期。 */
function deriveOfficialPickupDate(result, observedAt = new Date()) {
  const items = result?.products?.filter(item => item.quantity > 0) || [];
  if (!items.length || items.some(item => item.rawStatus !== 'PICKED_UP'))
    return { date: null, reason: 'NOT_ALL_ITEMS_PICKED_UP' };
  const dates = items.map(item =>
    resolvePickupDate(item.pickupDateText, result.orderPlacedDateText, observedAt)
  );
  if (dates.some(value => !value)) return { date: null, reason: 'PICKUP_DATE_UNAVAILABLE' };
  if (new Set(dates).size !== 1) return { date: null, reason: 'MULTIPLE_PICKUP_DATES' };
  return { date: dates[0], reason: null };
}

module.exports = { resolvePickupDate, deriveOfficialPickupDate };
