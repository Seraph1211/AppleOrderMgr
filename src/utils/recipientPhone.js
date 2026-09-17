const ApiError = require('./ApiError');

/**
 * 规范化选填联系电话；空值用于清空，非空必须符合现有手机号规则。
 * @param {unknown} value - 请求中的 phone
 * @returns {string|null} 规范化手机号或 null
 */
function normalizeRecipientPhone(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw ApiError.badRequest('联系电话必须为字符串');
  const phone = value.trim();
  if (!phone) return null;
  if (!/^1[3-9]\d{9}$/.test(phone)) throw ApiError.badRequest('联系电话格式无效');
  return phone;
}

module.exports = { normalizeRecipientPhone };
