import client from './client';

function serializeFilters(params = {}) {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      Array.isArray(value) ? JSON.stringify(value) : value,
    ])
  );
}

/** 获取授权范围内可搜索的 TAG 候选。 */
export const getPickupFilterOptions = () => client.get('/pickups/filter-options');
export const getPickupRecords = params =>
  client.get('/pickups', { params: serializeFilters(params) });
export const updatePickupRecord = (orderId, payload) => client.put(`/pickups/${orderId}`, payload);
export const getPickupEvents = orderId => client.get(`/pickups/${orderId}/events`);
export const preparePickupEvidence = (orderId, payload) =>
  client.post(`/pickups/${orderId}/evidence/prepare`, payload);
export const confirmPickupEvidence = (orderId, payload) =>
  client.post(`/pickups/${orderId}/evidence/confirm`, payload);
export const getPickupEvidenceUrl = (orderId, evidenceId) =>
  client.get(`/pickups/${orderId}/evidence/${evidenceId}`);

export async function exportPickupRecords(params) {
  const token = localStorage.getItem('token') || sessionStorage.getItem('token');
  const query = new URLSearchParams(
    Object.entries(serializeFilters(params)).filter(([, value]) => value)
  );
  const response = await fetch(`/api/pickups/export?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('导出取货清单失败');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `取货清单_${new Date().toISOString().slice(0, 10)}.xlsx`;
  anchor.click();
  URL.revokeObjectURL(url);
}
