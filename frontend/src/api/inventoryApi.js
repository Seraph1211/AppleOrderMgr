import client from './client';
/** 库存权限 API；个人筛选只发送给查询或显式手动检查。 */
export const inventoryApi = {
  get: (path, params) => client.get(`/inventory/${path}`, { params }),
  post: (path, data = {}) => client.post(`/inventory/${path}`, data),
  put: (path, data) => client.put(`/inventory/${path}`, data),
  export: params => client.get('/inventory/history/export', { params, responseType: 'text' }),
};
