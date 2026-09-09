const PAYMENT_ALIASES = new Map([
  ['微信', 'wechat'],
  ['微信支付', 'wechat'],
  ['wechat', 'wechat'],
  ['支付宝', 'alipay'],
  ['alipay', 'alipay'],
]);
const IPHONE_NAME =
  /^(iphone\d{1,2}(?:promax|pro|plus|mini|air|e)?)(?:(\d+(?:gb|tb|g|t))([\u4e00-\u9fff]{1,12}色)|([\u4e00-\u9fff]{1,12}色)(\d+(?:gb|tb|g|t)))$/;

/**
 * 统一文本格式，不删除业务词语。
 * @param {*} value - 待比较字段
 * @returns {string} 规范化文本
 */
function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function productNameKey(value) {
  const text = normalizeText(value);
  const match = text.match(IPHONE_NAME);
  if (!match) return `text:${text}`;
  const [, model, firstCapacity, lastColor, firstColor, lastCapacity] = match;
  const capacity = (firstCapacity || lastCapacity).replace(/([gt])$/, '$1b');
  return `iphone:${JSON.stringify([model, capacity, lastColor || firstColor])}`;
}

/**
 * 按字段进行保守等价判断；未知表达保留严格比较。
 * @param {string} field - paymentMethod、name 或其他字段
 * @param {*} source - 来源值
 * @param {*} official - 官网值
 * @returns {boolean} 是否等价
 */
function equivalentOrderValue(field, source, official) {
  if (field === 'name') return productNameKey(source) === productNameKey(official);
  const left = normalizeText(source);
  const right = normalizeText(official);
  if (field === 'paymentMethod') {
    return (PAYMENT_ALIASES.get(left) || left) === (PAYMENT_ALIASES.get(right) || right);
  }
  return left === right;
}

/**
 * 只清除历史记录中已能证明等价的表达冲突，不重放官网合并。
 * @param {Object} order - 当前订单及已有校验问题
 * @returns {Object|null} 仅含校验字段的补丁，无变化返回 null
 */
function revalidateExpressionConflicts(order) {
  if (!Array.isArray(order.validationIssues)) return null;
  const validationIssues = order.validationIssues.filter(issue => {
    if (issue?.type !== 'source_conflict') return true;
    let field = null;
    if (issue.field === 'paymentMethod') field = 'paymentMethod';
    else if (/^products\.\d+\.name$/.test(issue.field)) field = 'name';
    if (
      !field ||
      typeof issue.sourceValue !== 'string' ||
      typeof issue.officialValue !== 'string' ||
      !normalizeText(issue.sourceValue) ||
      !normalizeText(issue.officialValue)
    )
      return true;
    return !equivalentOrderValue(field, issue.sourceValue, issue.officialValue);
  });
  if (validationIssues.length === order.validationIssues.length) return null;
  return {
    validationIssues,
    validationStatus: validationIssues.length ? 'abnormal' : 'valid',
    anomalyDetectedAt: validationIssues.length ? order.anomalyDetectedAt : null,
  };
}

module.exports = { normalizeText, equivalentOrderValue, revalidateExpressionConflicts };
