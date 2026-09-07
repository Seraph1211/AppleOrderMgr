import client from './client';

export const getEmailProcessingRecords = params => client.get('/email-processing', { params });
export const getEmailProcessingMetrics = () => client.get('/email-processing/metrics');
export const getEmailProcessingRecord = id => client.get(`/email-processing/${id}`);
export const reparseEmailRecord = id => client.post(`/email-processing/${id}/reparse`);
export const saveEmailDraft = (id, draft, version) =>
  client.put(`/email-processing/${id}/draft`, { draft, version });
export const ingestEmailRecord = (id, draft, version) =>
  client.post(`/email-processing/${id}/ingest`, { draft, version });
export const batchReparseEmailRecords = ids =>
  client.post('/email-processing/batch-reparse', { ids });
export const resolveEmailRecord = (id, payload) =>
  client.post(`/email-processing/${id}/resolve`, payload);
