const ApiError = require('./ApiError');

/**
 * 规范每笔委托费用总额（元）；不舍入、不乘数量，空白保持未知。
 * @param {string|number|null|undefined} value 金额
 * @returns {string|null} 两位小数字符串或未登记
 */
function normalizeProxyFee(value) {
  if (value == null) return null;
  if (!['string', 'number'].includes(typeof value))
    throw ApiError.badRequest('代抢费用须为0–9999999999.99元，最多两位小数');
  const text = String(value).trim();
  if (!text) return null;
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text))
    throw ApiError.badRequest('代抢费用须为0–9999999999.99元，最多两位小数');
  const [whole, fraction = ''] = text.split('.');
  return `${Number(whole)}.${fraction.padEnd(2, '0')}`;
}

module.exports = { normalizeProxyFee };
