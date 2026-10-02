const ApiError = require('./ApiError');
/** 脱敏库存内部错误，同时保留已校验业务错误及内部诊断链。 @param {Error} error 原因 @returns {Error} 错误 */
function inventoryFailure(error) {
  if (error instanceof ApiError || error?.code === 'INVENTORY_OPERATION_FAILED') return error;
  const failure = ApiError.internal(
    '库存操作失败，请查看运行健康与服务日志',
    undefined,
    'INVENTORY_OPERATION_FAILED'
  );
  failure.cause = error;
  return failure;
}
module.exports = inventoryFailure;
