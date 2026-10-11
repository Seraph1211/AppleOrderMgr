const ApiError = require('./ApiError');
const MAX_MULTI_SELECT_ITEMS = 100;
const MAX_FILTER_VALUE_LENGTH = 255;

/**
 * 解析并校验查询中的单值或 JSON 数组多选参数。
 * @param {unknown} rawValue - 原始查询参数
 * @param {string} fieldName - 错误信息中的字段名
 * @param {Object} options - 白名单、数量和长度限制
 * @returns {string[]} 去重并去除首尾空白的值
 */
function parseMultiSelectFilter(
  rawValue,
  fieldName,
  {
    allowedValues = null,
    maxItems = MAX_MULTI_SELECT_ITEMS,
    maxLength = MAX_FILTER_VALUE_LENGTH,
    trimValues = true,
  } = {}
) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return [];
  let values = rawValue;
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        values = JSON.parse(trimmed);
      } catch (_error) {
        throw ApiError.badRequest(`${fieldName} 必须是合法数组`);
      }
    } else {
      values = [trimmed];
    }
  }
  if (!Array.isArray(values)) throw ApiError.badRequest(`${fieldName} 必须是合法数组`);
  if (values.length > maxItems) throw ApiError.badRequest(`${fieldName} 最多选择 ${maxItems} 项`);
  if (values.some(value => typeof value !== 'string')) {
    throw ApiError.badRequest(`${fieldName} 每项必须是字符串`);
  }
  const normalized = [
    ...new Set(values.map(value => (trimValues ? value.trim() : value)).filter(Boolean)),
  ];
  if (normalized.some(value => value.length > maxLength)) {
    throw ApiError.badRequest(`${fieldName} 每项不能超过 ${maxLength} 字符`);
  }
  if (allowedValues && normalized.some(value => !allowedValues.includes(value))) {
    throw ApiError.badRequest(`${fieldName} 包含非法值`);
  }
  return normalized;
}

module.exports = { parseMultiSelectFilter };
