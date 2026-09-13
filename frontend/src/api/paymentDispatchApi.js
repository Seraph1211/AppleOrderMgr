import client from './client';

export const getPaymentDispatchOverview = () => client.get('/payment-dispatch/overview');
export const getPaymentDispatchTasks = params => client.get('/payment-dispatch/tasks', { params });
export const updatePaymentDispatchSettings = payload =>
  client.put('/payment-dispatch/settings', payload);
export const updatePaymentStaffSettings = (userId, payload) =>
  client.put(`/payment-dispatch/staff/${userId}`, payload);
export const assignPaymentTask = (taskId, payload, idempotencyKey) =>
  client.put(`/payment-dispatch/tasks/${taskId}/assignee`, payload, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
export const assignPaymentTasks = (payload, idempotencyKey) =>
  client.put('/payment-dispatch/tasks/assignee', payload, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
export const refreshPaymentDispatchTask = taskId =>
  client.post(`/payment-dispatch/tasks/${taskId}/refresh`);
export const refreshPaymentDispatchTasks = taskIds =>
  client.post('/payment-dispatch/tasks/refresh', { taskIds });
export const reopenPaymentTask = (taskId, payload, idempotencyKey) =>
  client.post(`/payment-dispatch/tasks/${taskId}/reopen`, payload, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
export const runPaymentDispatchScan = () => client.post('/payment-dispatch/scan');

export const updatePaymentStaffSettingsBatch = staff =>
  client.put('/payment-dispatch/staff', { staff });

/** 查询 TAG 分配规则与 AOS TAG 候选。 */
export const getPaymentTagRules = () => client.get('/payment-dispatch/tag-rules');
/** 保存完整 TAG 分配规则。 */
export const savePaymentTagRule = (id, payload) =>
  id
    ? client.put(`/payment-dispatch/tag-rules/${id}`, payload)
    : client.post('/payment-dispatch/tag-rules', payload);
/** 按版本删除 TAG 分配规则。 */
export const deletePaymentTagRule = (id, expectedVersion) =>
  client.delete(`/payment-dispatch/tag-rules/${id}`, {
    data: { expectedVersion },
  });

/** 查询不受列表筛选影响的全局待付款订单数量。 */
export const getPendingPaymentOverview = () => client.get('/payment-dispatch/pending-overview');

/** 读取调度任务的付款链接。 */
export const getPaymentDispatchLink = taskId =>
  client.get(`/payment-dispatch/tasks/${taskId}/payment-link`);
