import client from './client';

export const getPaymentTasks = params => client.get('/payment-tasks', { params });
export const updatePaymentTask = (taskId, payload, idempotencyKey) =>
  client.put(`/payment-tasks/${taskId}`, payload, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
export const updatePaymentTaskPayer = (taskId, payload, idempotencyKey) =>
  client.put(`/payment-tasks/${taskId}/payer`, payload, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
export const getPaymentTaskLink = taskId => client.get(`/payment-tasks/${taskId}/payment-link`);
/** 从本人已分配任务的 AOS 原文按权限读取支付宝付款链接。 */
export const getPaymentTaskAlipayLink = taskId =>
  client.get(`/payment-tasks/${taskId}/alipay-payment-link`);
