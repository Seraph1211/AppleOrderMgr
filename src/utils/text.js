/**
 * 通用文本清理工具。
 * @module utils/text
 */

/**
 * 只保留有界纯文本业务字段，不接受链接、控制字符或非字符串对象。
 * @param {*} value - 待处理值
 * @param {number} [maximumLength=255] - 最大字符数
 * @returns {string|null} 清理后的文本
 */
function safeText(value, maximumLength = 255) {
  if (
    typeof value !== 'string' ||
    value.length > maximumLength ||
    /https?:\/\//i.test(value) ||
    [...value].some(character => character.charCodeAt(0) < 32)
  )
    return null;
  return value.trim();
}

module.exports = { safeText };
