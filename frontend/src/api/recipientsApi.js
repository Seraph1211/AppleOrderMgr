/**
 * 取机人 API
 * @module api/recipientsApi
 */

import client from './client'

/**
 * 获取取机人列表
 * @param {Object} params - 查询参数
 * @param {number} params.page - 页码
 * @param {number} params.limit - 每页数量
 * @param {string} params.status - 状态
 * @param {string} params.tag - 标签
 * @param {string} params.keyword - 搜索关键词
 * @returns {Promise<Object>} 取机人列表
 */
export const getRecipients = (params = {}) => {
  return client.get('/recipients', { params })
}

/**
 * 获取取机人详情
 * @param {number} id - 取机人 ID
 * @returns {Promise<Object>} 取机人详情
 */
export const getRecipientDetail = (id) => {
  return client.get(`/recipients/${id}`)
}

/**
 * 创建取机人
 * @param {Object} data - 取机人数据
 * @param {string} data.last_name - 姓
 * @param {string} data.first_name - 名
 * @param {string} data.id_card_number - 身份证号
 * @param {string} data.phone - 手机号
 * @param {string} data.email - 邮箱
 * @param {string} data.province - 省
 * @param {string} data.city - 市
 * @param {string} data.district - 区
 * @param {string} data.street_address - 街道地址
 * @param {string} data.tag - 标签
 * @returns {Promise<Object>} 创建结果
 */
export const createRecipient = (data) => {
  return client.post('/recipients', data)
}

/**
 * 更新取机人
 * @param {number} id - 取机人 ID
 * @param {Object} data - 更新数据
 * @returns {Promise<Object>} 更新结果
 */
export const updateRecipient = (id, data) => {
  return client.put(`/recipients/${id}`, data)
}

/**
 * 删除取机人
 * @param {number} id - 取机人 ID
 * @returns {Promise<Object>} 删除结果
 */
export const deleteRecipient = (id) => {
  return client.delete(`/recipients/${id}`)
}

/**
 * 批量生成取机人联系方式（电话和邮箱）
 * @param {Array<number>} recipientIds - 取机人ID数组
 * @returns {Promise<Object>} 生成结果
 */
export const batchGenerateContact = (recipientIds) => {
  return client.post('/recipients/batch-generate-contact', {
    recipient_ids: recipientIds
  })
}

/**
 * 批量生成地址
 * @param {Array<number>} recipientIds - 取机人ID数组
 * @param {string} province - 省份
 * @param {string} city - 城市
 * @param {string} district - 区县
 * @returns {Promise<Object>} 生成结果
 */
export const batchGenerateAddress = (recipientIds, province, city, district) => {
  return client.post('/recipients/batch-generate-address', {
    recipient_ids: recipientIds,
    province,
    city,
    district
  })
}

/**
 * 批量绑定 Apple ID
 * @param {Array<number>} recipientIds - 取机人ID数组
 * @returns {Promise<Object>} 绑定结果
 */
export const batchBindAppleIds = (recipientIds) => {
  return client.post('/recipients/bind-apple-ids', {
    recipientIds
  })
}
