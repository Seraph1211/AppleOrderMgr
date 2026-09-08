const os = require('os');

const { OrderRefreshSystemState } = require('../../models');
const logger = require('../../utils/logger');
const { config } = require('../../utils/config');
const proxyManager = require('../../utils/proxyManager');
const repository = require('./refreshJobRepository');
const refreshJobService = require('./refreshJobService');
const { classifyRefreshError, sanitizeRefreshError } = require('./refreshErrors');
const { isProxyProviderConfigured, isSupportedProxyProvider } = require('./proxy/proxyProvider');
const { validateProxyProviderCandidate } = require('./proxy/proxyHealthCheck');

const workerState = {
  workerId: `${os.hostname()}:${process.pid}`,
  timer: null,
  running: false,
};

/**
 * 将代理切换异常转换为不含凭据的稳定错误。
 * @param {Error} error - 原始异常
 * @returns {{code:string,message:string}} 脱敏错误
 */
function sanitizeProxySwitchError(error) {
  const allowedCodes = [
    'PROXY_407',
    'PROXY_441',
    'PROXY_517',
    'APPLE_541',
    'PROXY_TRANSPORT',
    'PROXY_POOL_EMPTY',
    'PROXY_CONFIG_MISSING',
    'PROXY_UNSUPPORTED_PROVIDER',
    'PROXY_SWITCH_SUPERSEDED',
  ];
  const code = allowedCodes.includes(error.code) ? error.code : 'PROXY_SWITCH_FAILED';
  const messages = {
    PROXY_407: '候选代理鉴权失败',
    PROXY_441: '候选代理请求频率受限',
    PROXY_517: '候选代理建链失败',
    APPLE_541: '候选代理访问 Apple 时触发风控',
    PROXY_TRANSPORT: '候选代理网络传输失败',
    PROXY_POOL_EMPTY: '候选代理池没有可用 IP',
    PROXY_CONFIG_MISSING: '候选代理 Provider 配置不完整',
    PROXY_UNSUPPORTED_PROVIDER: '代理 Provider 配置值不受支持',
    PROXY_SWITCH_SUPERSEDED: '切换请求已被更新的请求替代',
    PROXY_SWITCH_FAILED: '候选代理 Provider 初始化或检查失败',
  };
  return { code, message: messages[code] };
}

/**
 * 在当前批次边界同步 PostgreSQL 中的 Provider 切换意图。
 * @param {Object} state - 最新系统状态
 * @returns {Promise<Object>} 同步结果
 */
async function reconcileProxyProvider(state) {
  if (!config.proxy.enabled) return { skipped: true, reason: 'proxy_disabled' };
  const targetProvider = state.requestedProxyProvider || config.proxy.provider;
  const localStatus = proxyManager.getStatus();

  if (!isSupportedProxyProvider(targetProvider)) {
    const unsupportedError = new Error('unsupported');
    unsupportedError.code = 'PROXY_UNSUPPORTED_PROVIDER';
    const error = sanitizeProxySwitchError(unsupportedError);
    await repository.failProxyProviderSwitch(error.code, error.message);
    return { switched: false, errorCode: error.code };
  }

  if (
    state.proxySwitchStatus === 'failed' &&
    (state.requestedProxyProvider || config.proxy.provider) === targetProvider &&
    localStatus.activeProvider !== targetProvider
  ) {
    return { skipped: true, reason: 'awaiting_new_switch_request' };
  }

  if (localStatus.activeProvider === targetProvider && localStatus.isInitialized) {
    if (
      state.activeProxyProvider !== targetProvider ||
      ['pending', 'switching'].includes(state.proxySwitchStatus)
    ) {
      await repository.completeProxyProviderSwitch(targetProvider);
    }
    return { switched: false, activeProvider: targetProvider };
  }

  if (!isProxyProviderConfigured(config.proxy, targetProvider)) {
    const missingConfigError = new Error('missing');
    missingConfigError.code = 'PROXY_CONFIG_MISSING';
    const error = sanitizeProxySwitchError(missingConfigError);
    await repository.failProxyProviderSwitch(error.code, error.message);
    return { switched: false, errorCode: error.code };
  }

  await repository.startProxyProviderSwitch(targetProvider);
  try {
    const result = await proxyManager.switchProvider(targetProvider, {
      validateCandidate: async candidate => {
        await validateProxyProviderCandidate(candidate);
        const latestState = await repository.ensureSystemState();
        const latestTarget = latestState.requestedProxyProvider || config.proxy.provider;
        if (latestTarget !== targetProvider) {
          const supersededError = new Error('superseded');
          supersededError.code = 'PROXY_SWITCH_SUPERSEDED';
          throw supersededError;
        }
      },
    });
    await repository.completeProxyProviderSwitch(targetProvider);
    logger.info('爬虫代理 Provider 已切换', {
      previousProvider: result.previousProvider,
      activeProvider: targetProvider,
    });
    return { switched: result.changed, activeProvider: targetProvider };
  } catch (rawError) {
    const error = sanitizeProxySwitchError(rawError);
    if (error.code === 'PROXY_SWITCH_SUPERSEDED') {
      return { skipped: true, reason: 'switch_request_superseded' };
    }
    await repository.failProxyProviderSwitch(error.code, error.message);
    logger.warn('爬虫代理 Provider 切换失败，保留原 Provider', {
      targetProvider,
      activeProvider: proxyManager.getStatus().activeProvider,
      errorCode: error.code,
    });
    return { switched: false, errorCode: error.code };
  }
}

/**
 * 执行一个已领取任务并持久化最终状态。
 * @param {Object} job - 已领取任务
 * @returns {Promise<void>}
 */
async function processJob(job) {
  let outcome;
  try {
    const crawlerService = require('../crawlerService');
    const result = await crawlerService.crawlAndUpdateOrder(job.orderId, {
      source: job.trigger === 'auto' ? 'scheduled' : job.trigger,
      manual: job.trigger.startsWith('manual_'),
    });
    outcome = {
      success: true,
      skipped: Boolean(result?.skipped),
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
      await repository.pause('代理鉴权失败（HTTP 407）');
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
    const proxySwitch = await reconcileProxyProvider(state);
    if (!config.proxy.enabled) {
      return { skipped: true, reason: 'proxy_disabled', proxySwitch };
    }
    if (!proxyManager.getStatus().activeProvider) {
      return {
        skipped: true,
        reason: proxySwitch.errorCode || proxySwitch.reason || 'proxy_unavailable',
        proxySwitch,
      };
    }
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
      proxySwitch,
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

module.exports = {
  start,
  stop,
  runOnce,
  processJob,
  getStatus,
  getPersistentState,
  reconcileProxyProvider,
  sanitizeProxySwitchError,
};
