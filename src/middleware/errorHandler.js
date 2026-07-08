/**
 * 统一错误处理中间件
 * @module middleware/errorHandler
 * @description 捕获下游抛出的 ApiError / Sequelize 错误 / 通用 Error，返回 docs/05-API接口设计方案.md 第 4 节定义的统一错误格式
 */

const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

/**
 * Sequelize 校验错误的统一识别
 * @param {Error} err - 待识别错误
 * @returns {ApiError|null} 识别成功则返回对应的 ApiError，否则 null
 */
function mapSequelizeError(err) {
  if (!err) {
    return null;
  }

  // Unique constraint violation
  if (err.name === 'SequelizeUniqueConstraintError') {
    return ApiError.conflict('资源已存在', {
      fields: err.fields,
      value: err.errors?.[0]?.value,
    });
  }

  // Validation error
  if (err.name === 'SequelizeValidationError') {
    return ApiError.badRequest(
      '参数验证失败',
      {
        errors: err.errors?.map((e) => ({
          field: e.path,
          message: e.message,
        })),
      },
    );
  }

  // Foreign key constraint
  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return ApiError.badRequest('关联资源不存在', {
      fields: err.fields,
    });
  }

  // Database connection errors
  if (
    err.name === 'SequelizeConnectionError' ||
    err.name === 'SequelizeConnectionRefusedError' ||
    err.name === 'SequelizeHostNotFoundError' ||
    err.name === 'SequelizeAccessDeniedError'
  ) {
    return ApiError.database('数据库连接失败', { reason: err.message });
  }

  return null;
}

/**
 * Express 错误处理中间件
 * @param {Error} err - 错误对象
 * @param {import('express').Request} req - Express 请求
 * @param {import('express').Response} res - Express 响应
 * @param {import('express').NextFunction} _next - 下一个中间件
 * @returns {void}
 */
function errorHandler(err, req, res, _next) {
  const isDev = process.env.NODE_ENV !== 'production';

  // 已封装的业务错误
  if (err instanceof ApiError) {
    if (err.statusCode >= 500) {
      logger.error('API 业务错误', {
        method: req.method,
        url: req.originalUrl,
        code: err.code,
        message: err.message,
        details: err.details,
      });
    } else {
      logger.warn('API 业务错误', {
        method: req.method,
        url: req.originalUrl,
        code: err.code,
        message: err.message,
        details: err.details,
      });
    }

    return res
      .status(err.statusCode)
      .json({
        success: false,
        error: err.toJSON(isDev),
      });
  }

  // Sequelize 错误
  const seqError = mapSequelizeError(err);
  if (seqError) {
    logger.error('数据库错误', {
      method: req.method,
      url: req.originalUrl,
      message: seqError.message,
      details: seqError.details,
    });
    return res
      .status(seqError.statusCode)
      .json({
        success: false,
        error: seqError.toJSON(isDev),
      });
  }

  // body-parser JSON 解析错误
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    logger.warn('请求体 JSON 解析失败', {
      method: req.method,
      url: req.originalUrl,
      error: err.message,
    });
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: '请求体不是合法的 JSON',
        ...(isDev && { details: { reason: err.message } }),
      },
    });
  }

  // 兜底：未知错误
  logger.error('未处理异常', {
    method: req.method,
    url: req.originalUrl,
    message: err.message,
    stack: err.stack,
  });

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误',
      ...(isDev && { details: { message: err.message, stack: err.stack } }),
    },
  });
}

module.exports = errorHandler;
module.exports.mapSequelizeError = mapSequelizeError;
