const MOBILE_SECOND_DIGIT_MIN = 3;
const MOBILE_SECOND_DIGIT_RANGE = 7;
const DECIMAL_BASE = 10;
const MOBILE_SUFFIX_LENGTH = 9;

/**
 * 生成符合中国大陆手机号基础格式的 11 位号码。
 *
 * 号码以 1 开头，第二位为 3-9，其余九位为数字；不固定使用特定号段。
 *
 * @param {Function} random - 返回 [0, 1) 数值的随机函数，默认使用 Math.random
 * @returns {string} 符合 /^1[3-9]\d{9}$/ 的手机号
 */
function generatePhone(random = Math.random) {
  const secondDigit = Math.floor(random() * MOBILE_SECOND_DIGIT_RANGE) + MOBILE_SECOND_DIGIT_MIN;
  const suffix = Array.from({ length: MOBILE_SUFFIX_LENGTH }, () =>
    Math.floor(random() * DECIMAL_BASE)
  ).join('');

  return `1${secondDigit}${suffix}`;
}

module.exports = { generatePhone };
