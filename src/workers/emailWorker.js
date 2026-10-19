/**
 * 邮件监听独立 Worker 入口。
 * @module workers/emailWorker
 */

require('dotenv').config();

const { sequelize } = require('../models');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');
const { validateConfig } = require('../utils/config');
const { validateEncryptionConfiguration } = require('../utils/fieldEncryption');

async function shutdown(signal) {
  try {
    logger.info('邮件 Worker 正在关闭', { signal });
    await emailService.stopEmailService();
    await sequelize.close();
    process.exit(0);
  } catch (error) {
    logger.error('邮件 Worker 关闭失败', { signal, error: error.message });
    process.exit(1);
  }
}

try {
  validateConfig();
  validateEncryptionConfiguration();
  emailService.startEmailService();
  logger.info('邮件 Worker 已启动');
} catch (error) {
  logger.error('邮件 Worker 启动失败', { error: error.message });
  process.exit(1);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
