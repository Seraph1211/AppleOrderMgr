/** 格式化每笔委托的代抢费用总额，未知与零值保持区分。 */
export function formatProxyFee(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return '未登记';
  if (getProxyFeeError(value)) return '待核对';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

/** 返回费用输入错误；空白允许保存为未登记，服务端执行相同精度校验。 */
export function getProxyFeeError(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return '';
  return ['string', 'number'].includes(typeof value) &&
    /^\d{1,10}(?:\.\d{1,2})?$/.test(String(value).trim())
    ? ''
    : '请输入0–9999999999.99元，最多两位小数';
}
