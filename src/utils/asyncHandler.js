/**
 * async 异常包装工具
 * @module utils/asyncHandler
 * @description 让 controller 内抛出的异步异常能进入 Express 错误处理中间件，避免引入额外依赖
 */

/**
 * 把 async (req, res, next) 函数包装成 Express 兼容 handler
 * @param {Function} fn - async controller 函数
 * @returns {Function} Express handler
 */
function asyncHandler(fn) {
  return function asyncHandlerWrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
