const logger = require('../../utils/logger');
const { config } = require('../../utils/config');
const repository = require('./refreshJobRepository');

/**
 * 延迟指定时间。
 * @param {number} ms - 毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 从 PostgreSQL 全局游标预留请求时隙并等待。
 * @returns {Promise<void>}
 */
async function acquire() {
  try {
    const requestsPerSecond = Math.max(1, Math.min(config.crawler.requestsPerSecond || 5, 10));
    const intervalMs = Math.ceil(1000 / requestsPerSecond);
    const jitterMs = Math.floor(Math.random() * Math.min(50, intervalMs));
    const waitMs = await repository.reserveRequestSlot(intervalMs + jitterMs);
    if (waitMs > 0) await sleep(waitMs);
  } catch (error) {
    logger.error('预留全局爬虫请求时隙失败', { error: error.message });
    throw error;
  }
}

module.exports = { acquire, sleep };
