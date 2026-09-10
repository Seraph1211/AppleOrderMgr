import client from './client';

/** 读取来源管理数据。 @param {string} path 子路径 @param {Object} params 查询 @returns {Promise<Object>} 响应 */
export const readIngestion = (path, params) => client.get(`/order-ingestion${path}`, { params });
/** 使用稳定幂等键执行管理写入。 @param {string} method 方法 @param {string} path 子路径 @param {Object} data 请求 @param {string} key 幂等键 @returns {Promise<Object>} 响应 */
export const writeIngestion = (method, path, data, key) =>
  client.request({
    method,
    url: `/order-ingestion${path}`,
    data,
    headers: { 'Idempotency-Key': key },
  });
