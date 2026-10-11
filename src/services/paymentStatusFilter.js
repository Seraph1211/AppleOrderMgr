const { Op } = require('sequelize');
const { EMAIL_ORDER_STATUSES } = require('../constants/business');
const ApiError = require('../utils/ApiError');
const { parseMultiSelectFilter } = require('../utils/multiSelectFilter');
const { buildOfficialStatusCondition } = require('../utils/officialStatusFilter');

/**
 * 解析两张付款列表的邮件订单状态筛选。
 * @param {Object} query 请求筛选条件
 * @returns {Object|null} Sequelize 状态条件；未选择时为空
 */
function buildEmailStatusCondition(query) {
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
  if (!statuses.length) return null;
  return { [Op.in]: [...new Set(statuses)] };
}

/** 付款官网状态与订单管理共用解析和精确复合匹配，不改变历史邮件兼容参数。 */
function buildPaymentOfficialStatusCondition(query, sequelize, Sequelize) {
  if (query.officialOrderStatus !== undefined)
    throw ApiError.badRequest(
      '请使用官网状态多选参数 officialOrderStatuses',
      undefined,
      'FILTER_RETIRED'
    );
  const statuses = parseMultiSelectFilter(query.officialOrderStatuses, 'officialOrderStatuses', {
    maxItems: 100,
    maxLength: 100,
  });
  return buildOfficialStatusCondition(statuses, sequelize, Sequelize, 'order');
}

module.exports = {
  buildEmailStatusCondition,
  buildPaymentOfficialStatusCondition,
  EMAIL_ORDER_STATUSES,
};
