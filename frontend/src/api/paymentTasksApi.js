import client from "./client";

export const getPaymentTasks = (params) =>
  client.get("/payment-tasks", { params });
export const updatePaymentTask = (taskId, payload, idempotencyKey) =>
  client.put(`/payment-tasks/${taskId}`, payload, {
    headers: { "Idempotency-Key": idempotencyKey },
  });
export const updatePaymentTaskPayer = (taskId, payload, idempotencyKey) =>
  client.put(`/payment-tasks/${taskId}/payer`, payload, {
    headers: { "Idempotency-Key": idempotencyKey },
  });
export const getPaymentTaskLink = (taskId) =>
  client.get(`/payment-tasks/${taskId}/payment-link`);
export const refreshPaymentTask = (taskId) =>
  client.post(`/payment-tasks/${taskId}/refresh`);
export const getPaymentTaskRefreshJob = (taskId, jobId) =>
  client.get(`/payment-tasks/${taskId}/refresh/${jobId}`);
