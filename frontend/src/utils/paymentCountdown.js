import { getPaymentStageLabel } from './paymentStage.js';

import { getPaymentDeadlineTime } from './paymentDeadline.js';

/**
 * 格式化付款倒计时，统一使用来源下单时间，与分配及复制截止一致。
 * @param {Object} task 付款任务 DTO
 * @param {number|Date} now 服务器校准的当前时间
 * @param {string} unknownText 无有效时间时的文案
 * @returns {{text: string, className: string}} 显示文案与颜色
 */
export function formatPaymentCountdown(task, now, unknownText = '时间未知') {
  const stage = getPaymentStageLabel(task);
  if (stage) return { text: stage, className: 'text-gray-600' };
  const deadline = getPaymentDeadlineTime(task.orderDate);
  if (!Number.isFinite(deadline) || !Number.isFinite(Number(now))) {
    return { text: unknownText, className: 'text-gray-500' };
  }
  const seconds = Math.floor((deadline - Number(now)) / 1000);
  if (seconds <= 0) {
    return {
      text: '已超时',
      className: 'text-red-500 font-medium',
    };
  }
  return {
    text: `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`,
    className: seconds <= 300 ? 'text-red-600 font-medium' : 'text-gray-700',
  };
}
