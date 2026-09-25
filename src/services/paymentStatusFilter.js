const { Op } = require('sequelize');
const { EMAIL_ORDER_STATUSES } = require('../constants/business');
const ApiError = require('../utils/ApiError');

/**
 * 解析两张付款列表的邮件订单状态筛选。
 * @param {Object} query 请求筛选条件
 * @returns {Object|null} Sequelize 状态条件；未选择时为空
 */
function buildEmailStatusCondition(query) {
  if (query.officialOrderStatus !== undefined || query.officialOrderStatuses !== undefined) {
    throw ApiError.badRequest(
      '官网订单状态筛选参数已退休，请使用 emailOrderStatus 或 emailOrderStatuses',
      undefined,
      'FILTER_RETIRED'
    );
  }
  let statuses = query.emailOrderStatuses;
  if (statuses === undefined) {
    if (!query.emailOrderStatus) return null;
    statuses = [query.emailOrderStatus];
  } else if (typeof statuses === 'string') {
    try {
      statuses = JSON.parse(statuses);
    } catch (_error) {
      throw ApiError.badRequest('emailOrderStatuses 必须是状态数组');
    }
  }
  if (
    !Array.isArray(statuses) ||
    statuses.length > EMAIL_ORDER_STATUSES.length ||
    statuses.some(status => typeof status !== 'string' || !EMAIL_ORDER_STATUSES.includes(status))
  ) {
    throw ApiError.badRequest('emailOrderStatuses 包含非法状态或数量超限');
  }
  return { [Op.in]: [...new Set(statuses)] };
}

module.exports = { buildEmailStatusCondition, EMAIL_ORDER_STATUSES };
