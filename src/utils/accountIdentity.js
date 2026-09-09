const ApiError = require('./ApiError');

/**
 * 生成稳定可读的账号编号。
 * @param {number|string} id - 用户主键
 * @returns {string} 账号编号
 */
function accountId(id) {
  return `U${String(id).padStart(4, '0')}`;
}

/**
 * 验证并规范化昵称。
 * @param {unknown} value - 外部输入
 * @returns {string} 昵称
 */
function normalizeNickname(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 50 ||
    Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw ApiError.badRequest('昵称须为 1–50 个字符，不能包含控制字符');
  }
  return value.trim();
}

module.exports = { accountId, normalizeNickname };
