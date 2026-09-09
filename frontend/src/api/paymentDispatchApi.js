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
