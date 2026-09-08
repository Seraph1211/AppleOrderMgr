const ERROR_CODES = {
  541: 'APPLE_541',
  429: 'APPLE_429',
  407: 'PROXY_407',
};
const KDL_ERROR_CODES = {
  441: 'PROXY_441',
  517: 'PROXY_517',
};

/**
 * 将爬虫异常归类为可持久化错误码。
 * @param {Error|Object} error - 原始异常
 * @returns {string} 结构化错误码
 */
function classifyRefreshError(error) {
  const status = error?.httpStatus || error?.response?.status;
  if (ERROR_CODES[status]) return ERROR_CODES[status];
  if (
    (!error?.proxyProvider || String(error.proxyProvider).startsWith('kdl_')) &&
    KDL_ERROR_CODES[status]
  ) {
    return KDL_ERROR_CODES[status];
  }
  if (error?.eventType === 'order_identity') return 'IDENTITY';
  if (error?.eventType === 'product_validation') return 'VALIDATION';
  if (error?.eventType === 'parse') return 'PARSE';
  if (error?.eventType === 'database') return 'DATABASE';
  if (error?.eventType === 'proxy' || error?.code?.startsWith?.('E')) return 'PROXY_TRANSPORT';
  return 'UNKNOWN';
}

/**
 * 生成不包含链接、邮箱或代理凭据的错误摘要。
 * @param {Error|Object} error - 原始异常
 * @returns {string} 脱敏摘要
 */
function sanitizeRefreshError(error) {
  return String(error?.message || '未知刷新错误')
    .replace(/https?:\/\/\S+/gi, '[URL已隐藏]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已隐藏]')
    .replace(/(proxy-authorization\s*[:=]\s*)\S+/gi, '$1[已隐藏]')
    .slice(0, 500);
}

module.exports = { classifyRefreshError, sanitizeRefreshError };
