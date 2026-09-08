/**
 * 邮件处理稳定错误类型与分类。
 * @module services/emailErrors
 */

const EMAIL_ERROR_CODES = Object.freeze({
  MIME_TOO_LARGE: 'MIME_TOO_LARGE',
  MIME_PARSE_FAILED: 'MIME_PARSE_FAILED',
  BODY_MISSING: 'BODY_MISSING',
  ORDER_BLOCK_MISSING: 'ORDER_BLOCK_MISSING',
  APPLE_ID_INVALID: 'APPLE_ID_INVALID',
  ORDER_NUMBER_INVALID: 'ORDER_NUMBER_INVALID',
  ORDER_URL_INVALID: 'ORDER_URL_INVALID',
  ORDER_URL_MISMATCH: 'ORDER_URL_MISMATCH',
  ORDER_DATE_INVALID: 'ORDER_DATE_INVALID',
  PRODUCT_INVALID: 'PRODUCT_INVALID',
  RECIPIENT_INVALID: 'RECIPIENT_INVALID',
  PAYMENT_METHOD_INVALID: 'PAYMENT_METHOD_INVALID',
  TAG_INVALID: 'TAG_INVALID',
  DATABASE_TEMPORARY: 'DATABASE_TEMPORARY',
  IMAP_TEMPORARY: 'IMAP_TEMPORARY',
  WORKER_INTERRUPTED: 'WORKER_INTERRUPTED',
  SUBJECT_NOT_ALLOWED: 'SUBJECT_NOT_ALLOWED',
  SENDER_NOT_ALLOWED: 'SENDER_NOT_ALLOWED',
  DUPLICATE_EVENT: 'DUPLICATE_EVENT',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  INVALID_STATE: 'INVALID_STATE',
  UNKNOWN: 'UNKNOWN',
});

class EmailProcessingError extends Error {
  /**
   * @param {string} code - 稳定错误码
   * @param {string} message - 不包含外部原始值的错误摘要
   * @param {Object} [options] - 错误选项
   * @param {boolean} [options.retryable=false] - 是否允许自动重试
   * @param {Error} [options.cause] - 原始错误
   */
  constructor(code, message, { retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EmailProcessingError';
    this.code = code;
    this.retryable = retryable;
    Error.captureStackTrace?.(this, EmailProcessingError);
  }
}

/**
 * 把未知异常归类为稳定错误码，不把外部错误文本写入持久化记录。
 * @param {Error} error - 原始异常
 * @returns {{ code: string, message: string, retryable: boolean }} 分类结果
 */
function classifyEmailError(error) {
  if (error instanceof EmailProcessingError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }

  const retryableDatabaseErrors = new Set([
    'SequelizeConnectionError',
    'SequelizeConnectionAcquireTimeoutError',
    'SequelizeConnectionRefusedError',
    'SequelizeDatabaseError',
    'SequelizeTimeoutError',
  ]);
  if (retryableDatabaseErrors.has(error?.name)) {
    return {
      code: EMAIL_ERROR_CODES.DATABASE_TEMPORARY,
      message: '数据库暂时不可用',
      retryable: true,
    };
  }

  return {
    code: EMAIL_ERROR_CODES.UNKNOWN,
    message: '邮件处理发生未分类错误',
    retryable: false,
  };
}

module.exports = { EMAIL_ERROR_CODES, EmailProcessingError, classifyEmailError };
