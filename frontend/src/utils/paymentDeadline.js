const PAYMENT_WINDOW_MS = 30 * 60 * 1000;
const PRECISE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DEADLINE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * 以来源下单时间加 30 分钟生成北京时间 HH:mm，不依赖官网时间。
 * @param {string|null|undefined} orderDate 任务列表的来源下单时间
 * @returns {string} 截止时间，来源时间缺失、不完整或无效时为 -
 */
export function formatPaymentDeadline(orderDate) {
  if (!PRECISE_TIME.test(orderDate || '')) return '-';
  const timestamp = Date.parse(orderDate);
  return Number.isFinite(timestamp)
    ? DEADLINE_FORMATTER.format(new Date(timestamp + PAYMENT_WINDOW_MS))
    : '-';
}
