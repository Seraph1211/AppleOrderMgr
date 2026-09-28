const logger = require('../utils/logger');
const { reconcile } = require('./proxyOrderService');
let timer = null;
let running = null;
/** 启动可恢复的代抢匹配器。 @returns {void} */
function start() {
  if (timer) return;
  const tick = () => {
    if (running) return;
    running = reconcile()
      .catch(error => {
        logger.warn('代抢匹配稍后重试', { errorType: error.name });
      })
      .finally(() => {
        running = null;
      });
  };
  timer = setInterval(tick, 20000);
  timer.unref();
  tick();
}
/** 停止领取并等待事务结束。 @returns {Promise<void>} 等待结果 */
async function stop() {
  try {
    clearInterval(timer);
    timer = null;
    await running;
  } catch (error) {
    logger.warn('代抢匹配关闭异常', { errorType: error.name });
  }
}
module.exports = { start, stop };
