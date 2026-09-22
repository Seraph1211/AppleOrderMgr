/**
 * 根据邮件付款证据展示付款终止原因。
 * @param {Object} task - 付款任务 DTO
 * @returns {string|null} 终态文案，仍需付款则返回 null
 */
export function getPaymentStageLabel(task) {
  return task.emailPaymentStatus === 'paid' ? '已付款' : null;
}
