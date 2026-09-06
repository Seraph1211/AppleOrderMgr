/**
 * API 脱敏工具。
 * @module utils/masking
 */

/**
 * 保留身份证后四位。
 * @param {*} value - 身份证号
 * @returns {string|null} 脱敏值
 */
function maskIdCard(value) {
  if (!value) return null;
  const normalized = String(value);
  return normalized.length >= 4 ? `**************${normalized.slice(-4)}` : '****';
}

/**
 * 脱敏手机号。
 * @param {*} value - 手机号
 * @returns {string|null} 脱敏值
 */
function maskPhone(value) {
  if (!value) return null;
  const normalized = String(value);
  if (normalized.length < 7) return '****';
  return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
}

/**
 * 脱敏地址，仅保留省市区。
 * @param {Object} value - 地址字段
 * @returns {string|null} 脱敏地址
 */
function maskAddress(value) {
  const parts = [value?.province, value?.city, value?.district].filter(Boolean);
  return parts.length > 0 ? `${parts.join('')}（详细地址已隐藏）` : null;
}

/**
 * 防止 CSV/Excel 公式注入。
 * @param {*} value - 单元格值
 * @returns {*} 安全值
 */
function escapeSpreadsheetFormula(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

module.exports = { maskIdCard, maskPhone, maskAddress, escapeSpreadsheetFormula };
