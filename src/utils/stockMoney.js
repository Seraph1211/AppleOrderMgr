const ApiError = require('./ApiError');
const MAX_CENTS = 99999999999999n;
/** 把传输用两位小数字符串转为整数分；绝不经过浮点数。 */
function cents(value, { positive = false, signed = false } = {}) {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d{0,11})\.\d{2}$/.test(value)) {
    throw ApiError.badRequest('金额必须是两位小数字符串', undefined, 'MONEY_INVALID');
  }
  const result = BigInt(value.replace('.', ''));
  if (
    (!signed && result < 0n) ||
    (positive && result <= 0n) ||
    result > MAX_CENTS ||
    result < -MAX_CENTS
  ) {
    throw ApiError.badRequest('金额超出允许范围', undefined, 'MONEY_INVALID');
  }
  return result;
}
/** 整数分格式化为两位金额。 */
function money(value) {
  const amount = BigInt(value);
  const abs = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
/** 精确求和。 */
function sumMoney(values) {
  return money(values.reduce((sum, value) => sum + cents(value), 0n));
}
/** 按稳定序列号分摊费用，余分从排序后的首台开始。 */
function allocateMoney(amount, units) {
  const total = cents(amount, { positive: true });
  if (!units.length) throw ApiError.badRequest('费用需要至少一台实机');
  const sorted = [...units].sort((a, b) => a.serialNumber.localeCompare(b.serialNumber));
  const count = BigInt(sorted.length);
  return sorted.map((unit, index) => ({
    saleUnitId: unit.id,
    amount: money(total / count + (BigInt(index) < total % count ? 1n : 0n)),
  }));
}
module.exports = { cents, money, sumMoney, allocateMoney };
