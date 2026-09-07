const os = require('os');

const { OrderRefreshSystemState } = require('../../models');
const logger = require('../../utils/logger');
const { config } = require('../../utils/config');
const repository = require('./refreshJobRepository');
const refreshJobService = require('./refreshJobService');
const { classifyRefreshError, sanitizeRefreshError } = require('./refreshErrors');

const workerState = {
  workerId: `${os.hostname()}:${process.pid}`,
  timer: null,
  running: false,
};

/**
 * 执行一个已领取任务并持久化最终状态。
 * @param {Object} job - 已领取任务
 * @returns {Promise<void>}
 */
async function processJob(job) {
  let outcome;
  try {
    const crawlerService = require('../crawlerService');
    await crawlerService.crawlAndUpdateOrder(job.orderId, {
      source: job.trigger === 'auto' ? 'scheduled' : 'manual',
      manual: job.trigger !== 'auto',
    });
    outcome = {
      success: true,
      nextAutoRefreshAt: await refreshJobService.calculateNextRefresh(job.orderId),
    };
  } catch (error) {
    const errorCode = classifyRefreshError(error);
    outcome = {
      success: false,
      errorCode,
      errorMessage: sanitizeRefreshError(error),
      nextAutoRefreshAt: await refreshJobService.calculateNextRefresh(job.orderId),
    };
    if (errorCode === 'PROXY_407') {
      await repository.pause('快代理鉴权失败（HTTP 407）');
    }
    logger.warn('订单刷新任务执行失败', { jobId: job.id, orderId: job.orderId, errorCode });
  }
  await repository.finishJob(job, outcome);
}

/**
 * 执行一次调度循环。
 * @returns {Promise<Object>} 循环摘要
 */
async function runOnce() {
  if (workerState.running) {
    await repository.heartbeat(workerState.workerId);
    return { skipped: true, reason: 'previous_tick_running' };
  }
  workerState.running = true;
  try {
    const state = await repository.heartbeat(workerState.workerId);
    if (state.isPaused) return { skipped: true, reason: state.pauseReason || 'paused' };
    const recovered = await repository.recoverExpiredLeases();
    const scheduled = await refreshJobService.enqueueDueAutoJobs(config.crawler.scheduleScanLimit);
    const jobs = await repository.claimDueJobs(
      workerState.workerId,
      config.crawler.workerConcurrency,
      config.crawler.jobLeaseMs
    );
    const outcomes = await Promise.allSettled(jobs.map(processJob));
    const persistenceFailures = outcomes.filter(outcome => outcome.status === 'rejected');
    if (persistenceFailures.length > 0) {
      logger.error('刷新任务结果持久化失败，任务将等待租约恢复', {
        count: persistenceFailures.length,
        errors: persistenceFailures.map(outcome => outcome.reason?.message || 'unknown'),
      });
    }
    return {
      skipped: false,
      recovered,
      scheduled,
      claimed: jobs.length,
      persistenceFailures: persistenceFailures.length,
    };
  } catch (error) {
    logger.error('订单刷新 Worker 调度失败', { error: error.message, stack: error.stack });
    throw error;
  } finally {
    workerState.running = false;
  }
}

/**
 * 启动持久化任务 Worker。
 * @returns {Promise<Object>} Worker 状态
 */
async function start() {
  try {
    if (!config.crawler.autoRefreshEnabled) {
      logger.info('订单刷新 Worker 未启用');
      return getStatus();
    }
    if (workerState.timer) return getStatus();
    await repository.ensureSystemState();
    workerState.timer = setInterval(() => {
      runOnce().catch(error => logger.error('订单刷新调度循环失败', { error: error.message }));
    }, config.crawler.schedulerTickMs);
    workerState.timer.unref?.();
    await runOnce();
    logger.info('订单刷新持久化 Worker 已启动', {
      workerId: workerState.workerId,
      concurrency: config.crawler.workerConcurrency,
      tickMs: config.crawler.schedulerTickMs,
    });
    return getStatus();
  } catch (error) {
    logger.error('启动订单刷新 Worker 失败', { error: error.message });
    throw error;
  }
}

/**
 * 停止 Worker 新一轮领取。
 * @returns {void}
 */
function stop() {
  if (workerState.timer) clearInterval(workerState.timer);
  workerState.timer = null;
}

/**
 * 获取当前进程 Worker 状态。
 * @returns {Object} 状态摘要
 */
function getStatus() {
  return {
    enabled: config.crawler.autoRefreshEnabled,
    workerId: workerState.workerId,
    isRunning: Boolean(workerState.timer),
    isProcessing: workerState.running,
  };
}

/**
 * 获取持久化暂停状态。
 * @returns {Promise<Object|null>} 状态记录
 */
function getPersistentState() {
  return OrderRefreshSystemState.findByPk(1);
}

module.exports = { start, stop, runOnce, processJob, getStatus, getPersistentState };
