/**
 * 渠道管理 API
 */
import client from './client'

/**
 * 获取渠道列表
 * @returns {Promise} 渠道列表
 */
export async function getChannels() {
  return client.get('/channels')
}

/**
 * 获取渠道详细统计
 * @param {string} tag - 渠道标签
 * @returns {Promise} 渠道统计数据
 */
export async function getChannelStats(tag) {
  return client.get(`/channels/${encodeURIComponent(tag)}/stats`)
}

/**
 * 获取渠道订单列表
 * @param {string} tag - 渠道标签
 * @param {Object} params - 查询参数
 * @returns {Promise} 渠道订单列表
 */
export async function getChannelOrders(tag, params = {}) {
  return client.get(`/channels/${encodeURIComponent(tag)}/orders`, { params })
}

/**
 * 修改渠道名称
 * @param {string} oldTag - 原渠道标签
 * @param {string} newTag - 新渠道标签
 * @returns {Promise} 更新结果
 */
export async function updateChannelName(oldTag, newTag) {
  return client.put(`/channels/${encodeURIComponent(oldTag)}`, { newTag })
}
