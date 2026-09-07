/**
 * 日志工具模块
 * 功能：基于 Winston 的结构化日志系统
 * 作者：Seraph
 * 更新：2026-07-06
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logsDir = path.join(__dirname, '../../logs');

/**
 * 创建日志格式化器
 * @returns {winston.Logform.Format} Winston 格式化器
 */
const createLogFormat = () => {
  return winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
    }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;

      // 添加上下文信息
      if (Object.keys(meta).length > 0) {
        log += ` ${JSON.stringify(meta)}`;
      }

      return log;
    })
  );
};

/**
 * 创建 Winston Logger 实例
 * @returns {winston.Logger} Logger 实例
 */
const createLogger = () => {
  const transports = [
    new winston.transports.Console({
      format:
        process.env.NODE_ENV === 'production'
          ? winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            winston.format.json()
          )
          : createLogFormat(),
    }),
  ];

  if (process.env.LOG_TO_FILES === 'true') {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        maxsize: 5242880,
        maxFiles: 5,
      }),
      new winston.transports.File({
        filename: path.join(logsDir, 'combined.log'),
        maxsize: 5242880,
        maxFiles: 10,
      })
    );
  }

  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { service: 'apple-order-manager' },
    transports,
  });

  return logger;
};

// 创建并导出全局 logger 实例
const logger = createLogger();

module.exports = logger;
