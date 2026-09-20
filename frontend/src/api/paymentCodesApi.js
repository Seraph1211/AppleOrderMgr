import client from './client';

/** 沿用当前任务权限读取付款码，供本地识读；不访问支付地址。 */
export const getPaymentTaskCode = taskId => client.get(`/payment-tasks/${taskId}/payment-code`);

/** 沿用调度读取权限取得付款码，供本地识读。 */
export const getPaymentDispatchCode = taskId =>
  client.get(`/payment-dispatch/tasks/${taskId}/payment-code`);
