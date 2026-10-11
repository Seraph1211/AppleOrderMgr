const service = require('./paymentOfficialRefreshService');
const logger = require('../utils/logger');
const INTERVAL_MS = 180_000;
let timer = null;
let active = null;

/** 生产 API 常驻三分钟核对，关闭网页仍运行；异常仅记录错误分类。 */
function start() {
  if (timer || !service.automaticEnabled()) return;
  const tick = () => {
    if (active) return;
    active = service
      .scan()
      .catch(error => {
        logger.warn('付款官网自动核对未完成', { errorCode: error.code || error.name });
      })
      .finally(() => {
        active = null;
      });
  };
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  tick();
}

/** 停止新扫描并等待在途数据库事务，保留队列任务。 */
function stop() {
  clearInterval(timer);
  timer = null;
  return active || Promise.resolve();
}
module.exports = { start, stop };
