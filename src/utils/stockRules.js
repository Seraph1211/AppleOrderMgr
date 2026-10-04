const crypto = require('crypto');
const ApiError = require('./ApiError');
/** 拒绝非法 UUID。 */
function uuid(value, label = 'ID') {
  if (
    typeof value !== 'string' ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)
  )
    throw ApiError.badRequest(`${label}格式无效`);
  return value;
}
/** 校验必填或可选纯文本。 */
function text(value, label, max = 200, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw ApiError.badRequest(`${label}长度应为1至${max}`);
  return value.trim();
}
/** 校验业务时间，必须显式时区。 */
function instant(value, label = '业务时间') {
  const match =
    typeof value === 'string' &&
    value.match(
      /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/
    );
  if (
    !match ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59 ||
    Number(match[7] || 0) > 14 ||
    Number(match[8] || 0) > 59 ||
    (Number(match[7]) === 14 && Number(match[8]) !== 0) ||
    !Number.isFinite(Date.parse(value))
  )
    throw ApiError.badRequest(`${label}须为有效带时区时间`, undefined, 'DATE_INVALID');
  dateOnly(match[1]);
  return new Date(value);
}
/** 校验拿货日期。 */
function dateOnly(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw ApiError.badRequest('拿货日期无效', undefined, 'DATE_INVALID');
  return value;
}
/** 校验非空数组和上限。 */
function array(value, max = 100, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > max)
    throw ApiError.badRequest(`列表长度应为${allowEmpty ? 0 : 1}至${max}`);
  return value;
}
/** 校验固定枚举。 */
function choice(value, choices, label = '类型') {
  if (!choices.includes(value)) throw ApiError.badRequest(`${label}无效`);
  return value;
}
/** 递归稳定序列化用于业务幂等摘要。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, stable(value[key])])
    );
  return value;
}
/** 不保存原始业务请求的不可逆摘要。 */
function digest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
/** 拒绝未在白名单中的字段。 */
function only(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))
  )
    throw ApiError.badRequest('包含未知字段');
}
module.exports = { uuid, text, instant, dateOnly, array, choice, stable, digest, only };
