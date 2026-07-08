/**
 * API 统一响应格式工具
 * @module utils/apiResponse
 * @description 封装 { success, data | error } 标准格式，保持与 docs/05-API接口设计方案.md 一致
 */

const ApiError = require('./ApiError');

/**
 * 构造成功响应体
 * @param {*} [data=null] - 业务数据
 * @returns {{ success: boolean, data: * }} 响应体
 */
function successResponse(data = null) {
  return {
    success: true,
    data,
  };
}

/**
 * 构造失败响应体
 * @param {string} code - 业务错误码
 * @param {string} message - 错误消息
 * @param {Object} [details] - 附加上下文
 * @param {boolean} [includeStack=false] - 是否携带堆栈
 * @returns {{ success: boolean, error: Object }} 响应体
 */
function errorResponse(code, message, details = undefined, includeStack = false) {
  const errorPayload = { code, message };
  if (details !== undefined) {
    errorPayload.details = details;
  }
  if (includeStack) {
    errorPayload.stack = details?.stack || new Error().stack;
  }
  return {
    success: false,
    error: errorPayload,
  };
}

/**
 * 构造分页响应体
 * @param {Array} rows - 当前页数据
 * @param {number} total - 总记录数
 * @param {number} page - 当前页码（从 1 开始）
 * @param {number} limit - 每页记录数
 * @returns {{ success: boolean, data: { total: number, page: number, limit: number, [key: string]: * } }} 响应体
 */
function paginatedResponse(rows, total, page, limit, listKey = 'items') {
  return {
    success: true,
    data: {
      total,
      page,
      limit,
      [listKey]: rows,
    },
  };
}

/**
 * 解析 query 中的正整数（page / limit 等），并施加上下限
 * @param {*} raw - 原始字符串或数字
 * @param {Object} options - 选项
 * @param {number} options.defaultValue - 默认值
 * @param {number} options.min - 最小值
 * @param {number} options.max - 最大值
 * @returns {number} 整数
 */
function parsePositiveInt(raw, { defaultValue, min, max }) {
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.min(Math.max(parsed, min), max);
}

module.exports = {
  successResponse,
  errorResponse,
  paginatedResponse,
  parsePositiveInt,
  ApiError,
};
