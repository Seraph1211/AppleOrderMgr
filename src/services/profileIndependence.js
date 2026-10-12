const ApiError = require('../utils/ApiError');

/** 旧绑定功能的统一退役错误，不包含账号或证件资料。 */
function bindingRetiredError() {
  return new ApiError(
    410,
    'PROFILE_BINDING_RETIRED',
    '取机人与 Apple ID 已独立维护，绑定功能不再使用'
  );
}

/** 拒绝旧客户端的非空关联输入，允许历史表单的空兼容字段。 */
function rejectLegacyBindingFields(payload, account = false) {
  const fields = account
    ? ['recipientId', 'recipientRef', 'recipient_id', 'recipient_ref', 'recipients']
    : ['appleId', 'appleIdRef', 'apple_id', 'apple_id_ref', 'password', 'expectedAppleIdRef'];
  if (
    fields.some(
      field => payload[field] !== undefined && payload[field] !== null && payload[field] !== ''
    )
  ) {
    throw ApiError.badRequest(
      '档案已独立维护，请移除旧账号或绑定字段',
      undefined,
      'PROFILE_BINDING_RETIRED'
    );
  }
}

/** 已退役筛选不能悄悄返回全部档案。 */
function rejectLegacyBindingFilters(query) {
  if (
    ['bound', 'apple_id_ref', 'apple_id'].some(
      field => query[field] !== undefined && query[field] !== ''
    )
  ) {
    throw ApiError.badRequest(
      '绑定筛选已不再使用，请刷新页面',
      undefined,
      'PROFILE_BINDING_RETIRED'
    );
  }
}

module.exports = { bindingRetiredError, rejectLegacyBindingFields, rejectLegacyBindingFilters };
