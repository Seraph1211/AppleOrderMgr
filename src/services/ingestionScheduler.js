/** API 内 AOS 执行器，跨进程去重由数据库租约保证。 */
const aos = require('./aosIngestionService');
const repo = require('./ingestionRepository');
let checkedDay = null;
const logger = require('../utils/logger');
let timer = null;
let running = null;

/** 启动执行器。 @returns {void} */
function start() {
  if (timer) return;
  const tick = () => {
    if (running) return;
    running = Promise.resolve()
      .then(async () => {
        try {
          if (checkedDay !== repo.businessDate()) {
            await repo.ingestionTransaction((transaction, settings) =>
              repo.refreshEligibility(settings, transaction)
            );
            checkedDay = repo.businessDate();
          }
          return await aos.processQueue();
        } catch (error) {
          logger.debug('AOS 周期处理稍后重试', { errorCode: 'TEMPORARILY_UNAVAILABLE' });
          throw error;
        }
      })
      .catch(() => {
        logger.warn('AOS 队列稍后恢复', { errorCode: 'TEMPORARILY_UNAVAILABLE' });
      })
      .finally(() => {
        running = null;
      });
  };
  timer = setInterval(tick, 1000);
  timer.unref();
  tick();
}

/** 停止领取并等待当前事务。 @returns {Promise<void>} 等待结果 */
async function stop() {
  try {
    clearInterval(timer);
    timer = null;
    await running;
  } catch (_error) {
    logger.warn('AOS 执行器关闭等待异常', { errorCode: 'TEMPORARILY_UNAVAILABLE' });
  }
}
module.exports = { start, stop };
