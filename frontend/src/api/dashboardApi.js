/**
 * 仪表板 API
 * @module api/dashboardApi
 */

import client from './client'

/**
 * 获取统计概览
 * @returns {Promise<Object>} 统计数据
 */
export const getStats = () => {
  return client.get('/stats/overview')
}

/**
 * 获取 Apple ID 统计
 * @returns {Promise<Object>} Apple ID 统计
 */
export const getAppleIdStats = () => {
  return client.get('/stats/apple-ids')
}

/**
 * 获取取机人统计
 * @returns {Promise<Object>} 取机人统计
 */
export const getRecipientStats = () => {
  return client.get('/stats/recipients')
}

/**
 * 获取商品统计
 * @returns {Promise<Object>} 商品统计
 */
export const getProductStats = () => {
  return client.get('/stats/products')
}
