require('dotenv').config();
const { sequelize } = require('../models');
const { validateEncryptionConfiguration } = require('../utils/fieldEncryption');
const { sendNext } = require('../services/wecomNotificationSender');
const logger = require('../utils/logger');
let timer;
let inFlight;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  try {
    await inFlight;
    await sequelize.close();
  } catch (error) {
    logger.error('企微通知Worker关闭失败', { errorType: error.name });
    process.exitCode = 1;
  }
}
async function main() {
  try {
    validateEncryptionConfiguration();
    await sequelize.authenticate();
    timer = setInterval(() => {
      if (!inFlight && !stopping)
        inFlight = sendNext()
          .catch(() => undefined)
          .finally(() => {
            inFlight = null;
          });
    }, 1000);
    logger.info('企微通知Worker已启动，发送以数据库开关为准');
  } catch (error) {
    logger.error('企微通知Worker启动失败', { errorType: error.name });
    await sequelize.close();
    process.exitCode = 1;
  }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
main();
