const crypto = require('crypto');

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, normalize(value[key])])
    );
  }
  return value;
}

/** 生成跨重试稳定的规范化 JSON。 @param {unknown} value 输入 @returns {string} JSON */
function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

/** 生成规范化 SHA-256 摘要。 @param {unknown} value 输入 @returns {string} 十六进制摘要 */
function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** 批次摘要排除每次 HTTP 尝试可变化的 sentAt。 @param {Object} batch 批次 @returns {string} 摘要 */
function batchDigest(batch) {
  const stable = { ...batch };
  delete stable.sentAt;
  return digest(stable);
}

module.exports = { batchDigest, canonicalJson, digest };
