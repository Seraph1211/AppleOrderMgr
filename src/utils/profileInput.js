const ApiError = require('./ApiError');
const { ACCOUNT_STATUSES } = require('../constants/business');
const { normalizeRecipientPhone } = require('./recipientPhone');

/** 检查基础资料跨资源操作权限，不能借取机人编辑绕过账号权限。 */
function hasPermission(req, permission) {
  return Boolean(req.user?.permissions?.includes(permission));
}
/** 拒绝未授权操作。 */
function assertPermission(req, permission) {
  if (!hasPermission(req, permission))
    throw new ApiError(403, 'FORBIDDEN', '缺少所需操作权限', { permission });
}
/** 验证密保三组问答，null 表示显式清空。 */
function validateSecurityQa(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw ApiError.badRequest('密保格式错误');
  const result = {};
  for (let i = 1; i <= 3; i++) {
    for (const key of [`question${i}`, `answer${i}`]) {
      if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 1000)
        throw ApiError.badRequest('密保必须包含完整的三组问题和答案');
      result[key] = value[key];
    }
  }
  return result;
}
/** 账号文本字段边界，导入和手工编辑共用。 */
function validateAccountText(payload) {
  for (const [key, max] of Object.entries({
    appleId: 255,
    password: 2000,
    country: 50,
    notes: 10000,
  })) {
    const value = payload[key];
    if (value != null && (typeof value !== 'string' || value.length > max))
      throw ApiError.badRequest(`${key} 格式或长度无效`);
  }
}
/** 严格正整数标识。 */
function profileId(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
    throw ApiError.badRequest('ID 必须是正整数');
  return Number(value);
}
/** 取机人资料白名单与校验，账号绑定由独立事务处理。 */
function recipientInput(payload, creating = false) {
  const out = {};
  const lengths = {
    lastName: 50,
    firstName: 50,
    idCardNumber: 18,
    email: 255,
    province: 50,
    city: 50,
    district: 50,
    streetAddress: 255,
    tag: 100,
    notes: 10000,
  };
  for (const [key, max] of Object.entries(lengths)) {
    if (payload[key] === undefined) continue;
    if (payload[key] !== null && (typeof payload[key] !== 'string' || payload[key].length > max))
      throw ApiError.badRequest(`${key} 格式或长度无效`);
    out[key] = payload[key]?.trim() ? (key === 'tag' ? payload[key] : payload[key].trim()) : null;
  }
  for (const key of ['lastName', 'firstName', 'idCardNumber']) {
    if ((creating || payload[key] !== undefined) && !out[key])
      throw ApiError.badRequest(`${key} 不能为空`);
  }
  if (out.idCardNumber) {
    out.idCardNumber = out.idCardNumber.toUpperCase();
    if (
      !/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dX]$/.test(
        out.idCardNumber
      )
    )
      throw ApiError.badRequest('身份证号格式无效，必须为文本形式的18位号码');
  }
  for (const key of ['phone', 'realPhone']) {
    if (payload[key] !== undefined) out[key] = normalizeRecipientPhone(payload[key]);
  }
  if (out.email && !/^[^\s@]+@vvv8\.net$/i.test(out.email))
    throw ApiError.badRequest('下单邮箱必须使用 @vvv8.net');
  if (payload.status !== undefined) {
    if (!ACCOUNT_STATUSES.includes(payload.status)) throw ApiError.badRequest('使用状态无效');
    out.status = payload.status;
  } else if (creating) out.status = '未使用';
  return out;
}
module.exports = {
  validateAccountText,
  hasPermission,
  assertPermission,
  validateSecurityQa,
  profileId,
  recipientInput,
};
