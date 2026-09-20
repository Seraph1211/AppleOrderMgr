require('dotenv').config();
const { sequelize } = require('../models');
const { validateEncryptionConfiguration } = require('../utils/fieldEncryption');
const { startOrderMailSync } = require('../services/orderMailSync');
const { sendNextOrderMail } = require('../services/orderMailSender');
const { purgeOrderMail } = require('../services/orderMailService');
const { processNextLifecycleJob } = require('../services/orderMailLifecycleService');
const logger = require('../utils/logger');

let scanner;
let timer;
let inFlight;
let stopping = false;
let lastPurge = 0;

async function tick() {
  try {
    if (Date.now() - lastPurge > 3600000) {
      await purgeOrderMail();
      lastPurge = Date.now();
    }
    for (let count = 0; count < 10 && !stopping; count += 1) {
      if (!(await sendNextOrderMail())) break;
    }
    for (let count = 0; count < 10 && !stopping; count += 1) {
      if (!(await processNextLifecycleJob())) break;
    }
  } catch (error) {
    logger.error('订单邮件后台任务失败', { errorType: error.name });
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  try {
    await scanner?.stop();
    await inFlight;
    await sequelize.close();
  } catch (error) {
    logger.error('订单邮件Worker关闭失败', { errorType: error.name });
    process.exitCode = 1;
  }
}

async function main() {
  try {
    validateEncryptionConfiguration();
    await sequelize.authenticate();
    scanner = await startOrderMailSync();
    timer = setInterval(() => {
      if (!inFlight)
        inFlight = tick().finally(() => {
          inFlight = null;
        });
    }, 3000);
    logger.info('订单邮件Worker已启动');
  } catch (error) {
    logger.error('订单邮件Worker启动失败', { errorType: error.name });
    await sequelize.close();
    process.exitCode = 1;
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
main();
