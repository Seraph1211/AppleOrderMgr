/**
 * 订单 API
 * @module api/ordersApi
 */

import client from './client'

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
  return client.get('/orders', { params })
}

/**
 * 获取订单详情
 * @param {number} id - 订单 ID
 * @returns {Promise<Object>} 订单详情
 */
export const getOrderDetail = (id) => {
  return client.get(`/orders/${id}`)
}

/**
 * 手动刷新订单（爬取最新数据）
 * @param {number} id - 订单 ID
 * @returns {Promise<Object>} 刷新结果
 */
export const refreshOrder = (id) => {
  return client.post(`/orders/${id}/refresh`)
}

/**
 * 批量刷新订单
 * @param {number[]} ids - 订单 ID 列表
 * @returns {Promise<Object>} 批量刷新结果
 */
export const batchRefreshOrders = (ids) => {
  return client.post('/orders/batch-refresh', { order_ids: ids })
}

/**
 * 更新订单信息
 * @param {number} id - 订单 ID
 * @param {Object} data - 更新数据
 * @param {string} data.payerName - 付款人
 * @param {string} data.paymentScreenshot - 付款截图 URL
 * @returns {Promise<Object>} 更新结果
 */
export const updateOrder = (id, data) => {
  return client.put(`/orders/${id}`, data)
}
