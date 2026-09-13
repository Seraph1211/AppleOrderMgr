const { Op } = require('sequelize');
const { ORDER_STATUSES } = require('../constants/business');
const ApiError = require('../utils/ApiError');

/**
 * 解析两张付款列表的官网订单状态筛选，兼容旧单值参数。
 * @param {Object} query 请求筛选条件
 * @returns {Object|null} Sequelize 状态条件；未选择时为空
 */
function buildOfficialStatusCondition(query) {
  let statuses = query.officialOrderStatuses;
  if (statuses === undefined) {
    if (!query.officialOrderStatus) return null;
    statuses = [query.officialOrderStatus];
  } else if (typeof statuses === 'string') {
    try {
      statuses = JSON.parse(statuses);
    } catch (_error) {
      throw ApiError.badRequest('officialOrderStatuses 必须是状态数组');
    }
  }
  if (
    !Array.isArray(statuses) ||
    statuses.length > ORDER_STATUSES.length ||
    statuses.some(status => typeof status !== 'string' || !ORDER_STATUSES.includes(status))
  ) {
    throw ApiError.badRequest('officialOrderStatuses 包含非法状态或数量超限');
  }
  return statuses.length ? { [Op.in]: [...new Set(statuses)] } : null;
}

module.exports = { buildOfficialStatusCondition };
