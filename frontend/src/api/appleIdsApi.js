/**
 * Apple ID API
 * @module api/appleIdsApi
 */

import client from './client'

/**
 * 获取 Apple ID 列表
 * @param {Object} params - 查询参数
 * @param {number} params.page - 页码
 * @param {number} params.limit - 每页数量
 * @param {string} params.status - 状态
 * @param {string} params.keyword - 搜索关键词
 * @returns {Promise<Object>} Apple ID 列表
 */
export const getAppleIds = (params = {}) => {
  return client.get('/apple-ids', { params })
}

/**
 * 获取 Apple ID 详情
 * @param {number} id - Apple ID
 * @returns {Promise<Object>} Apple ID 详情
 */
export const getAppleIdDetail = (id) => {
  return client.get(`/apple-ids/${id}`)
}

/**
 * 创建 Apple ID
 * @param {Object} data - Apple ID 数据
 * @param {string} data.apple_id - Apple ID 邮箱
 * @param {string} data.password - 密码
 * @param {string} data.nickname - 备注名称
 * @param {string} data.country - 国家地区
 * @param {string} data.status - 状态
 * @returns {Promise<Object>} 创建结果
 */
export const createAppleId = (data) => {
  return client.post('/apple-ids', data)
}

/**
 * 更新 Apple ID
 * @param {number} id - Apple ID
 * @param {Object} data - 更新数据
 * @returns {Promise<Object>} 更新结果
 */
export const updateAppleId = (id, data) => {
  return client.put(`/apple-ids/${id}`, data)
}

/**
 * 删除 Apple ID
 * @param {number} id - Apple ID
 * @returns {Promise<Object>} 删除结果
 */
export const deleteAppleId = (id) => {
  return client.delete(`/apple-ids/${id}`)
}
