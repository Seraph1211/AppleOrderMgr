require('dotenv').config();
const { sequelize, MonitorNotificationChannel } = require('../models');
const { validateEncryptionConfiguration } = require('../utils/fieldEncryption');
const logger = require('../utils/logger');
const sender = require('../services/monitorNotificationSender');
const scheduler = require('../services/monitorNotificationScheduler');
const retention = require('../services/monitorNotificationRetention');
const timers = [];
const running = new Map();
let stopping = false;

function lane(name, interval, work) {
  const tick = () => {
    if (stopping || running.has(name)) return;
    const promise = work()
      .catch(error =>
        logger.error('监控通知执行未完成', { lane: name, errorCode: error.code || error.name })
      )
      .finally(() => running.delete(name));
    running.set(name, promise);
  };
  tick();
  timers.push(setInterval(tick, interval));
}
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearInterval(timer);
  try {
    await Promise.allSettled([...running.values()]);
    await sender.stop();
    await sequelize.close();
  } catch (error) {
    logger.error('监控通知Worker关闭失败', { errorCode: error.code || error.name });
    process.exitCode = 1;
  }
}
async function main() {
  try {
    validateEncryptionConfiguration();
    await sequelize.authenticate();
    if ((await MonitorNotificationChannel.count({ where: { senderGeneration: 2 } })) !== 2)
      throw new Error('MONITOR_SENDER_GENERATION_REQUIRED');
    // 两条发送lane各自有限并发与网络超时，一边等待不阻塞另一边。
    lane('email', 1000, () => sender.processOne(new Date(), { channel: 'email' }));
    lane('wecom', 1000, () => sender.processOne(new Date(), { channel: 'wecom' }));
    lane('scheduler', 15000, () => scheduler.scheduleTick());
    lane('cleanup', 3600000, () => retention.cleanup());
    logger.info('独立监控通知Worker已启动，目标开关由数据库控制');
  } catch (error) {
    logger.error('监控通知Worker启动失败', { errorCode: error.code || error.name });
    await stop();
    process.exitCode = 1;
  }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
main();
