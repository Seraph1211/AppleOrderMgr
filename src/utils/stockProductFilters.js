const ApiError = require('./ApiError');
const MAX_FILTER_VALUES = 100;

/** 解析并严格校验三维多选条件；只输出绑定参数，不拼接外部 SQL。 */
function parseStockProductFilters(query) {
  const result = {};
  for (const [key, maxLength] of [
    ['modelNames', 100],
    ['storageGbs', 0],
    ['colorNames', 64],
  ]) {
    if (query[key] === undefined) {
      result[key] = [];
      continue;
    }
    let values;
    try {
      if (typeof query[key] !== 'string') throw new Error('类型错误');
      values = JSON.parse(query[key]);
    } catch (_error) {
      throw ApiError.badRequest(`${key} 必须是 JSON 数组`);
    }
    if (
      !Array.isArray(values) ||
      values.length > MAX_FILTER_VALUES ||
      values.some(value =>
        key === 'storageGbs'
          ? !Number.isInteger(value) || value <= 0 || value > 2147483647
          : typeof value !== 'string' || !value.trim() || value.length > maxLength
      )
    )
      throw ApiError.badRequest(`${key} 筛选值无效`);
    result[key] = [...new Set(values)];
  }
  return result;
}
module.exports = { parseStockProductFilters };
