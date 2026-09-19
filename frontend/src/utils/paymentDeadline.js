const PAYMENT_WINDOW_MS = 30 * 60 * 1000;
const PRECISE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DEADLINE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: '2-digit',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * 以来源下单时间加 30 分钟生成北京时间 YY/MM/DD HH:mm，不依赖官网时间。
 * @param {string|null|undefined} orderDate 任务列表的来源下单时间
 * @returns {string} 截止时间，来源时间缺失、不完整或无效时为 -
 */
export function formatPaymentDeadline(orderDate) {
  if (!PRECISE_TIME.test(orderDate || '')) return '-';
  const timestamp = Date.parse(orderDate);
  if (!Number.isFinite(timestamp)) return '-';
  const parts = Object.fromEntries(
    DEADLINE_FORMATTER.formatToParts(new Date(timestamp + PAYMENT_WINDOW_MS)).map(part => [
      part.type,
      part.value,
    ])
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}
