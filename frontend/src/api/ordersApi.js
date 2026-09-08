/**
 * 订单 API
 * @module api/ordersApi
 */

import client from './client';

/**
 * 获取订单列表
 * @param {Object} params - 查询参数
 * @param {number} params.page - 页码
 * @param {number} params.limit - 每页数量
 * @param {string} params.status - 订单状态
 * @param {string} params.keyword - 搜索关键词
 * @returns {Promise<Object>} 订单列表
 */
export const getOrders = (params = {}) => {
  return client.get('/orders', { params });
};

/**
 * 获取订单详情
 * @param {number} id - 订单 ID
 * @returns {Promise<Object>} 订单详情
 */
export const getOrderDetail = id => {
  return client.get(`/orders/${id}`);
};

export const getOrderFilterOptions = () => client.get('/orders/filter-options');

export const exportOrders = async (params = {}) => {
  const blob = await client.get('/orders/export', {
    params,
    responseType: 'blob',
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `orders_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
};

/**
 * 手动刷新订单（爬取最新数据）
 * @param {number} id - 订单 ID
 * @returns {Promise<Object>} 刷新结果
 */
export const refreshOrder = id => {
  return client.post(`/orders/${id}/refresh`);
};

/**
 * 批量刷新订单
 * @param {number[]} ids - 订单 ID 列表
 * @returns {Promise<Object>} 批量刷新结果
 */
export const batchRefreshOrders = ids => {
  return client.post('/orders/batch-refresh', { order_ids: ids });
};

/** 提交刷新全部批次。 */
export const refreshAllOrders = () => client.post('/orders/refresh-all');

/** 为当前页面可见订单提交页面打开刷新。 */
export const submitPageOpenRefresh = ids =>
  client.post('/orders/page-open-refresh', { order_ids: ids });

/** 查询刷新任务状态。 */
export const getRefreshJob = id => client.get(`/order-refresh/jobs/${id}`);

/** 查询刷新全部批次状态。 */
export const getRefreshBatch = id => client.get(`/order-refresh/batches/${id}`);

/**
 * 更新订单信息
 * @param {number} id - 订单 ID
 * @param {Object} data - 更新数据
 * @param {string[]} data.paymentScreenshot - 付款截图 URL 数组
 * @returns {Promise<Object>} 更新结果
 */
export const updateOrder = (id, data) => {
  return client.put(`/orders/${id}`, data);
};

/** 通过受审计的专用端点更新订单付款人。 */
export const updateOrderPayer = (id, data, idempotencyKey) =>
  client.put(`/orders/${id}/payer`, data, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
