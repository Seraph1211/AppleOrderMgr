/**
 * API 业务错误类型
 * @module utils/ApiError
 * @description 在 controller / service 层抛出，可在 errorHandler 中被序列化为统一错误响应
 */

/**
 * 构造 API 业务错误
 * @param {number} statusCode - HTTP 状态码（如 400 / 404 / 409 / 500）
 * @param {string} code - 业务错误码（与 docs/05-API接口设计方案.md 中"错误码定义"一致）
 * @param {string} message - 面向调用方的可读错误消息
 * @param {Object} [details] - 附加上下文，可选
 */
class ApiError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
    Error.captureStackTrace?.(this, ApiError);
  }

  /**
   * 序列化为对外响应的 error 对象
   * @param {boolean} [includeStack=false] - 是否包含堆栈（仅开发模式）
   * @returns {Object} 响应体中的 error 字段
   */
  toJSON(includeStack = false) {
    const payload = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) {
      payload.details = this.details;
    }
    if (includeStack && this.stack) {
      payload.stack = this.stack;
    }
    return payload;
  }
}

/**
 * 常用错误快捷构造
 */
ApiError.badRequest = (message, details, code = 'VALIDATION_ERROR') =>
  new ApiError(400, code, message, details);

ApiError.notFound = (message = '资源不存在', details, code = 'NOT_FOUND') =>
  new ApiError(404, code, message, details);

ApiError.conflict = (message = '资源已存在', details, code = 'DUPLICATE_ENTRY') =>
  new ApiError(409, code, message, details);

ApiError.internal = (message = '服务器内部错误', details, code = 'INTERNAL_ERROR') =>
  new ApiError(500, code, message, details);

ApiError.database = (message = '数据库操作失败', details) =>
  new ApiError(500, 'DATABASE_ERROR', message, details);

ApiError.crawler = (message = '爬虫执行失败', details) =>
  new ApiError(500, 'CRAWLER_ERROR', message, details);

module.exports = ApiError;
