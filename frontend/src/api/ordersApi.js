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
 * @param {string[]} params.emailOrderStatuses - 邮件订单状态
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

/** 按权限读取单个订单链接，仅在用户点击复制时请求。 */
export const getOrderLink = id => client.get(`/orders/${id}/link`);

export const getOrderFilterOptions = params => client.get('/orders/filter-options', { params });

export const exportOrders = async (params = {}) => {
  const query = { ...params };
  for (const key of ['orderIds', 'fields']) {
    if (Array.isArray(query[key])) query[key] = JSON.stringify(query[key]);
  }
  const blob = await client.get('/orders/export', {
    params: query,
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
