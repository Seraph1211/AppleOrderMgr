/**
 * 日志工具模块
 * 功能：基于 Winston 的结构化日志系统
 * 作者：Seraph
 * 更新：2026-07-06
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// 确保日志目录存在
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

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
  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { service: 'apple-order-manager' },
    transports: [
      // 错误日志单独文件
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 5,
      }),
      // 所有日志
      new winston.transports.File({
        filename: path.join(logsDir, 'combined.log'),
        maxsize: 5242880, // 5MB
        maxFiles: 10,
      }),
    ],
  });

  // 开发环境输出到控制台
  if (process.env.NODE_ENV !== 'production') {
    logger.add(
      new winston.transports.Console({
        format: createLogFormat(),
      })
    );
  }

  return logger;
};

// 创建并导出全局 logger 实例
const logger = createLogger();

module.exports = logger;
