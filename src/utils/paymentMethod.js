/** AOS 已确认的支付方式；分期产品不与普通微信或支付宝合并。 */
const PAYMENT_METHODS = Object.freeze([
  '微信',
  '支付宝',
  '花呗12期',
  '招行12期',
  '招行24期',
  '建行12期',
  '建行24期',
  '工行12期',
  '工行24期',
  '微信分付12期',
  '微信分付24期',
  '支付宝银行12期',
  '支付宝银行24期',
  'VISA',
  'MASTERCARD',
]);
const PAYMENT_ALIASES = new Map([
  ...PAYMENT_METHODS.map(method => [method.toLowerCase(), method]),
  ['微信支付', '微信'],
  ['wechat', '微信'],
  ['wechat pay', '微信'],
  ['alipay', '支付宝'],
]);

/** 将已知支付方式归一化；未知方式返回 null。 @param {*} value 原文 @returns {string|null} 方式 */
function normalizePaymentMethod(value) {
  if (typeof value !== 'string') return null;
  return PAYMENT_ALIASES.get(value.normalize('NFKC').trim().toLowerCase()) || null;
}

/** 仅普通微信支持微信付款码。 @param {*} value 方式 @returns {boolean} 是否微信 */
function isWechatPayment(value) {
  return normalizePaymentMethod(value) === '微信';
}

/** 仅普通支付宝及其明确别名使用 AOS 支付宝付款链接。 @param {*} value 方式 @returns {boolean} 是否支付宝 */
function isAlipayPayment(value) {
  return normalizePaymentMethod(value) === '支付宝';
}

/** 读取完整来源方式，兼容历史已被官网覆盖的订单，不回写数据。 @param {Object} order 订单 @returns {string|null} 方式 */
function getSourcePaymentMethod(order) {
  const source = order?.sourceSnapshot?.paymentMethod;
  if (typeof source === 'string' && source.trim()) return source.trim();
  const current = order?.paymentMethod;
  return typeof current === 'string' && current.trim() ? current.trim() : null;
}

module.exports = {
  PAYMENT_METHODS,
  normalizePaymentMethod,
  isWechatPayment,
  isAlipayPayment,
  getSourcePaymentMethod,
};
