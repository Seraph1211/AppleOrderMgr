const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 将下单时间转换为北京时间文本；日期值不补造时分秒。 */
function formatOrderTime(value) {
  if (!value || value === '-') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value).replace(/-/g, '/');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ')
    .replace(/-/g, '/');
}

/** 将日期筛选转换为北京时间完整日边界；精确时间保留其时区。 */
function parseOrderTimeBoundary(value, end = false) {
  const text = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T${end ? '23:59:59.999' : '00:00:00.000'}+08:00`);
    if (formatOrderTime(parsed).slice(0, 10) !== text.replace(/-/g, '/')) return new Date(NaN);
    return parsed;
  }
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)
    ? `${text}+08:00`
    : text;
  return new Date(normalized);
}

/** 仅识别被日期值覆盖为 UTC 午夜且有同日精确来源快照的历史记录。 */
function getRestorableOrderTime(order) {
  const original = order.sourceSnapshot?.orderDate;
  if (!original || !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(original))
    return null;
  const source = new Date(original);
  const current = new Date(order.orderDate);
  if (Number.isNaN(source.getTime()) || Number.isNaN(current.getTime())) return null;
  if (source.getTime() === current.getTime() || current.toISOString().slice(11) !== '00:00:00.000Z')
    return null;
  if (formatOrderTime(source).slice(0, 10) !== formatOrderTime(current).slice(0, 10)) return null;
  return source;
}

module.exports = { formatOrderTime, parseOrderTimeBoundary, getRestorableOrderTime };
