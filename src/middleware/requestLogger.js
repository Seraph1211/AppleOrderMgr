/**
 * HTTP 请求日志中间件
 * @module middleware/requestLogger
 * @description 记录每个 HTTP 请求的方法/路径/状态码/耗时，写入 Winston（combined.log）
 */

const logger = require('../utils/logger');

/**
 * 构造 HTTP 访问日志中间件
 * @returns {import('express').RequestHandler} Express 中间件
 */
function requestLogger() {
  return function requestLoggerMiddleware(req, res, next) {
    const startTime = process.hrtime.bigint();

    res.on('finish', () => {
      const costMs = Number(process.hrtime.bigint() - startTime) / 1e6;

      const logPayload = {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        costMs: Math.round(costMs * 100) / 100,
        ip: req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
        userAgent: req.headers['user-agent'],
      };

      if (res.statusCode >= 500) {
        logger.error('HTTP 请求', logPayload);
      } else if (res.statusCode >= 400) {
        logger.warn('HTTP 请求', logPayload);
      } else {
        logger.info('HTTP 请求', logPayload);
      }
    });

    next();
  };
}

module.exports = requestLogger;
