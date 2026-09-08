const logger = require('../utils/logger');
const paymentDispatchService = require('./paymentDispatchService');

const SCAN_INTERVAL_MS = 10_000;
let timer = null;
let running = false;

async function scan() {
  if (running) return;
  running = true;
  try {
    const result = await paymentDispatchService.runDispatchScan();
    if (result.enrolled || result.assigned) {
      logger.info('付款任务调度扫描完成', result);
    }
  } catch (error) {
    logger.error('付款任务调度扫描失败', { errorCode: error.code || 'DISPATCH_SCAN_FAILED' });
  } finally {
    running = false;
  }
}

/**
 * 启动 API 进程内的付款调度扫描器。全局配置默认关闭。
 * @returns {void}
 */
function start() {
  if (timer) return;
  timer = setInterval(scan, SCAN_INTERVAL_MS);
  timer.unref();
}

/**
 * 停止付款调度扫描器。
 * @returns {void}
 */
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, scan };
