import client from './client';

const root = '/identity-verifications';
export const identityApi = {
  status: () => client.get(`${root}/status`),
  list: params => client.get(`${root}/batches`, { params }),
  detail: id => client.get(`${root}/batches/${id}`),
  single: (data, key) =>
    client.post(`${root}/single`, data, {
      headers: { 'Idempotency-Key': key },
    }),
  preview: file => {
    const body = new FormData();
    body.append('file', file);
    return client.post(`${root}/preview`, body, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  control: (id, action) => client.post(`${root}/batches/${id}/${action}`),
};

/** 下载身份核验模板或原始结果。 @returns {Promise<void>} 完成 */
export async function downloadIdentityFile(id) {
  try {
    const blob = await client.get(id ? `${root}/batches/${id}/export` : `${root}/template`, {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = id ? `身份核验结果-${id.slice(0, 8)}.xlsx` : '身份核验模板.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}
