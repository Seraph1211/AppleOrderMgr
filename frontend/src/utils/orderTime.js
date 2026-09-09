/** 下单时间统一显示北京时间；只有日期时不补造时间。 */
export function formatOrderTime(value, fallback = '待核实') {
  if (!value || value === '-') return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value).replace(/-/g, '/');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Date(date.getTime() + 8 * 3600000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ')
    .replace(/-/g, '/');
}
