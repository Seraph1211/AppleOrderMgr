/**
 * 爬虫调度独立 Worker 入口。
 * @module workers/crawlerWorker
 */

require('dotenv').config();

const { sequelize } = require('../models');
const crawlerService = require('../services/crawlerService');
const logger = require('../utils/logger');
const { validateEncryptionConfiguration } = require('../utils/fieldEncryption');

async function shutdown(signal) {
  try {
    logger.info('爬虫 Worker 正在关闭', { signal });
    crawlerService.stopAutoRefreshScheduler();
    await sequelize.close();
    process.exit(0);
  } catch (error) {
    logger.error('爬虫 Worker 关闭失败', { signal, error: error.message });
    process.exit(1);
  }
}

async function start() {
  try {
    validateEncryptionConfiguration();
    await sequelize.authenticate();
    await crawlerService.startAutoRefreshScheduler();
    logger.info('爬虫 Worker 已启动');
  } catch (error) {
    logger.error('爬虫 Worker 启动失败', { error: error.message });
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
