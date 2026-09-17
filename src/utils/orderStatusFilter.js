const { Op } = require('sequelize');
const { ORDER_STATUSES } = require('../constants/business');

/** 为已校验的官网状态构造字段条件，unknown 包含未识别的存量值。 */
function buildOrderStatusCondition(statuses) {
  if (!statuses.length) return null;
  const values = [...new Set(statuses)];
  if (!values.includes('unknown')) return { [Op.in]: values };
  return {
    [Op.or]: [{ [Op.in]: values }, { [Op.notIn]: ORDER_STATUSES }, { [Op.is]: null }],
  };
}

module.exports = { buildOrderStatusCondition };
