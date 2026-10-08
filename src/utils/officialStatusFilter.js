const ApiError = require('./ApiError');

const NOT_OBSERVED = '__not_observed__';
const STATUS_ALIASES = {
  PICKUP_READY: 'READY_FOR_PICKUP',
  CANCELED: 'CANCELLED',
  PICK_UP_CANCELLED: 'PICKUP_CANCELLED',
};

/** 将官网同义状态归为同一个筛选候选，未知状态保持原文。 */
function canonicalOfficialStatus(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_ALIASES, status)
    ? STATUS_ALIASES[status]
    : status;
}

/** 从授权查询结果拆分状态并去重；缺失观测显示为独立选项。 */
function collectOfficialStatusOptions(rows) {
  const options = new Set();
  for (const row of rows) {
    const statuses = (row.officialRawStatus || '')
      .split('|')
      .map(value => value.trim())
      .filter(Boolean);
    if (!statuses.length) options.add(NOT_OBSERVED);
    for (const status of statuses) options.add(canonicalOfficialStatus(status));
  }
  return [...options].sort((left, right) => left.localeCompare(right));
}

/** 构造分隔项精确匹配条件；仅可信字段名进入 SQL，外部值统一转义。 */
function buildOfficialStatusCondition(statuses, sequelize, Sequelize) {
  if (!statuses.length) return null;
  if (statuses.some(status => status.includes('|'))) {
    throw ApiError.badRequest('officialOrderStatuses 每项必须是单个官网状态');
  }
  const values = new Set(
    statuses.filter(status => status !== NOT_OBSERVED).map(canonicalOfficialStatus)
  );
  for (const [alias, canonical] of Object.entries(STATUS_ALIASES)) {
    if (values.has(canonical)) values.add(alias);
  }
  const field = 'BTRIM(COALESCE("Order"."official_raw_status", \'\'))';
  const parts = [];
  if (statuses.includes(NOT_OBSERVED)) parts.push(`${field} = ''`);
  if (values.size) {
    const escaped = [...values].map(value => sequelize.escape(value)).join(', ');
    parts.push(`regexp_split_to_array(${field}, '\\s*\\|\\s*') && ARRAY[${escaped}]::text[]`);
  }
  return Sequelize.literal(`(${parts.join(' OR ')})`);
}

module.exports = { collectOfficialStatusOptions, buildOfficialStatusCondition };
