const { Op } = require('sequelize');
const { parseOrderTimeBoundary } = require('./orderTime');
const ApiError = require('./ApiError');

/**
 * 解析北京时间下单日期范围，兼容订单旧参数。
 * @param {Object} query 查询参数
 * @returns {Object|null} orderDate 比较条件
 */
function buildOrderDateCondition(query = {}) {
  const fromValue = query.dateFrom ?? query.date_from;
  const toValue = query.dateTo ?? query.date_to;
  const range = {};
  for (const [value, end, operator] of [
    [fromValue, false, Op.gte],
    [toValue, true, Op.lte],
  ]) {
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) {
      throw ApiError.badRequest('下单日期格式非法');
    }
    const date = parseOrderTimeBoundary(value, end);
    if (Number.isNaN(date.getTime())) throw ApiError.badRequest('下单日期不是有效日期');
    range[operator] = date;
  }
  if (range[Op.gte] && range[Op.lte] && range[Op.gte] > range[Op.lte]) {
    throw ApiError.badRequest('下单开始日期不能晚于结束日期');
  }
  return Reflect.ownKeys(range).length ? range : null;
}

module.exports = { buildOrderDateCondition };
