const { getSourcePaymentMethod, isWechatPayment } = require('../utils/paymentMethod');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const { getPaymentDeadline, isAssignmentBlocked } = require('./paymentEligibility');
const { validatePaymentPng } = require('./paymentCodeValidation');
const MAX_TEXT_BYTES = 2048;
const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: '2-digit',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const clean = value =>
  String(value || '')
    .split('')
    .map(char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char))
    .join('')
    .replace(/\|\|/g, '｜｜')
    .trim();

/** 判断支付方式是否为微信。 @param {string} method 支付方式 @returns {boolean} 是否微信 */
function isWechat(method) {
  return isWechatPayment(method);
}
/** 本地识读有效付款 PNG，不请求码内地址。 @param {string} value PNG @returns {string|null} 地址 */
function decodePaymentQr(value) {
  try {
    validatePaymentPng(value);
    const png = PNG.sync.read(Buffer.from(value.split(',')[1], 'base64'));
    // 与浏览器白底绘制保持一致，透明像素不当作黑色。
    for (let i = 0; i < png.data.length; i += 4) {
      const alpha = png.data[i + 3] / 255;
      for (let c = 0; c < 3; c += 1)
        png.data[i + c] = Math.round(png.data[i + c] * alpha + 255 * (1 - alpha));
      png.data[i + 3] = 255;
    }
    const decodedValue = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
    if (
      !decodedValue ||
      /\s/.test(decodedValue) ||
      [...decodedValue].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return null;
    const url = new URL(decodedValue);
    return url.protocol === 'weixin:' &&
      url.host === 'wxpay' &&
      !url.username &&
      !url.password &&
      url.pathname.length > 1
      ? decodedValue
      : null;
  } catch (_error) {
    return null;
  }
}
/** 返回发送前应跳过／失败的原因。 @param {Object} order 订单 @param {Date} now 当前时间 @returns {string|null} 原因 */
function orderBlockReason(order, now) {
  if (!order) return 'ORDER_MISSING';
  if (isAssignmentBlocked(order)) return 'ORDER_TERMINAL';
  const deadline = getPaymentDeadline(order);
  if (!deadline) return 'DEADLINE_MISSING';
  return +deadline <= +now ? 'ORDER_EXPIRED' : null;
}
/** 格式与付款复制一致，仅在 ID 后插入 TAG。 @param {Object} order 订单 @param {string} url 链接 @returns {string} 文本 */
function buildNotificationText(order, url) {
  const grouped = new Map();
  for (const product of Array.isArray(order.products) ? order.products : []) {
    const productName = clean(product?.name);
    const model = clean(product?.model);
    const name = productName || model;
    if (!name) continue;
    const qty = Number(product.quantity);
    const quantity = Number.isInteger(qty) && qty > 0 ? qty : 1;
    const key = JSON.stringify([name, model]);
    if (grouped.has(key)) grouped.get(key).quantity += quantity;
    else grouped.set(key, { name, quantity });
  }
  const products = [...grouped.values()].map(p => `${p.name} x ${p.quantity}`).join('、') || '-';
  const method = clean(getSourcePaymentMethod(order));
  const paymentMethod = isWechat(method)
    ? '微信'
    : method.toLowerCase() === 'alipay'
      ? '支付宝'
      : method || '-';
  const tag =
    clean(order.ingestionSource === 'aos' ? order.sourceRecipientTag || order.tag : order.tag) ||
    '-';
  const deadline = getPaymentDeadline(order);
  const parts = deadline
    ? Object.fromEntries(formatter.formatToParts(deadline).map(p => [p.type, p.value]))
    : null;
  const time = parts
    ? `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`
    : '-';
  return `${order.id} || ${tag} || ${products} || ${paymentMethod} || ${time} || ${url}`;
}
module.exports = {
  isWechat,
  decodePaymentQr,
  orderBlockReason,
  buildNotificationText,
  MAX_TEXT_BYTES,
};
