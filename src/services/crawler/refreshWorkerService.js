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

const RECOVERY_RETRY_MS = 60_000;
const workerState = {
  workerId: `${os.hostname()}:${process.pid}`,
  timer: null,
  running: false,
  stopping: false,
  tickFinished: Promise.resolve(),
  inFlight: new Map(),
  recoveryKey: null,
  recoveryRetryAt: 0,
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

  // 数据库 active 是上次有效值，新进程必须重新建立自己的代理实例。
  if (!localStatus.isInitialized && state.proxySwitchStatus === 'failed') {
    const recoveryProvider = state.activeProxyProvider;
    if (
      !recoveryProvider ||
      !isSupportedProxyProvider(recoveryProvider) ||
      !isProxyProviderConfigured(config.proxy, recoveryProvider)
    ) {
      return { skipped: true, reason: 'PROXY_RECOVERY_UNAVAILABLE' };
    }
    const recoveryKey = `${recoveryProvider}:${targetProvider}:${state.proxySwitchRequestedAt || ''}`;
    if (workerState.recoveryKey === recoveryKey && Date.now() < workerState.recoveryRetryAt) {
      return { skipped: true, reason: 'PROXY_RECOVERY_FAILED' };
    }
    workerState.recoveryKey = recoveryKey;
    workerState.recoveryRetryAt = Date.now() + RECOVERY_RETRY_MS;
    try {
      await proxyManager.switchProvider(recoveryProvider, {
        validateCandidate: async candidate => {
          try {
            await validateProxyProviderCandidate(candidate);
            const latest = await repository.ensureSystemState();
            if (
              latest.activeProxyProvider !== recoveryProvider ||
              latest.requestedProxyProvider !== state.requestedProxyProvider ||
              String(latest.proxySwitchRequestedAt) !== String(state.proxySwitchRequestedAt)
            ) {
              const error = new Error('恢复期间切换请求已更新');
              error.code = 'PROXY_SWITCH_SUPERSEDED';
              throw error;
            }
          } catch (error) {
            error.code = error.code || 'PROXY_RECOVERY_FAILED';
            throw error;
          }
        },
      });
      workerState.recoveryRetryAt = 0;
      logger.info('爬虫 Worker 已恢复最后有效代理', { activeProvider: recoveryProvider });
      return { switched: false, recovered: true, activeProvider: recoveryProvider };
    } catch (rawError) {
      const error = sanitizeProxySwitchError(rawError);
      if (error.code === 'PROXY_SWITCH_SUPERSEDED') {
        return { skipped: true, reason: 'switch_request_superseded' };
      }
      logger.warn('爬虫 Worker 代理恢复失败，暂停领取任务', {
        provider: recoveryProvider,
        errorCode: error.code,
      });
      return { skipped: true, reason: 'PROXY_RECOVERY_FAILED' };
    }
  }

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
      source:
        job.trigger === 'auto'
          ? 'scheduled'
          : job.trigger.startsWith('manual_')
            ? 'manual'
            : job.trigger,
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
  if (workerState.stopping) return { skipped: true, reason: 'worker_stopping' };
  if (workerState.running) {
    await repository.heartbeat(workerState.workerId);
    return { skipped: true, reason: 'previous_tick_running' };
  }
  workerState.running = true;
  let finishTick;
  workerState.tickFinished = new Promise(resolve => {
    finishTick = resolve;
  });
  try {
    const state = await repository.heartbeat(workerState.workerId);
    await repository.renewActiveLeases(
      workerState.workerId,
      [...workerState.inFlight.keys()],
      config.crawler.jobLeaseMs
    );
    const proxySwitch = workerState.inFlight.size
      ? { skipped: true, reason: 'active_jobs_running' }
      : await reconcileProxyProvider(state);
    const localProxy = proxyManager.getStatus();
    const proxyReady = Boolean(
      config.proxy.enabled && localProxy.activeProvider && localProxy.isInitialized
    );
    let blockedReason = proxySwitch.errorCode || proxySwitch.reason || 'PROXY_UNAVAILABLE';
    if (!config.proxy.enabled) blockedReason = 'PROXY_DISABLED';
    await repository.heartbeat(workerState.workerId, {
      workerProxyReady: proxyReady,
      workerProxyErrorCode: proxyReady ? null : blockedReason,
    });
    if (!config.proxy.enabled) {
      return { skipped: true, reason: 'proxy_disabled', proxySwitch };
    }
    if (!proxyReady) {
      return {
        skipped: true,
        reason: proxySwitch.errorCode || proxySwitch.reason || 'proxy_unavailable',
        proxySwitch,
      };
    }
    if (state.isPaused) return { skipped: true, reason: state.pauseReason || 'paused' };
    if (workerState.inFlight.size > 0 && requiresProxySwitch(state)) {
      return { skipped: true, reason: 'proxy_switch_draining' };
    }
    const availableSlots = config.crawler.workerConcurrency - workerState.inFlight.size;
    if (availableSlots <= 0) return { skipped: true, reason: 'concurrency_full' };
    const recovered = await repository.recoverExpiredLeases();
    const scheduled = await refreshJobService.enqueueDueAutoJobs(config.crawler.scheduleScanLimit);
    // 扫描期间可能出现暂停、切换或退出请求，领取前重新检查。
    const latestState = await repository.ensureSystemState();
    if (workerState.stopping) return { skipped: true, reason: 'worker_stopping' };
    if (latestState.isPaused) return { skipped: true, reason: 'paused' };
    if (requiresProxySwitch(latestState)) {
      return { skipped: true, reason: 'proxy_switch_draining' };
    }
    const jobs = await repository.claimDueJobs(
      workerState.workerId,
      availableSlots,
      config.crawler.jobLeaseMs
    );
    for (const job of jobs) {
      const completion = processJob(job)
        .catch(() => {
          logger.error('刷新任务结果持久化失败，任务将等待租约恢复', { jobId: job.id });
        })
        .finally(() => workerState.inFlight.delete(job.id));
      workerState.inFlight.set(job.id, completion);
    }
    return {
      skipped: false,
      recovered,
      scheduled,
      claimed: jobs.length,
      inFlight: workerState.inFlight.size,
      proxySwitch,
    };
  } catch (error) {
    logger.error('订单刷新 Worker 调度失败', { error: error.message, stack: error.stack });
    throw error;
  } finally {
    workerState.running = false;
    finishTick();
  }
}

/**
 * 是否需要先排空在途任务再处理代理切换。
 * @param {Object} state - 持久化系统状态
 * @returns {boolean} 是否停止补位
 */
function requiresProxySwitch(state) {
  if (state.proxySwitchStatus === 'failed') return false;
  const target = state.requestedProxyProvider || config.proxy.provider;
  return (
    target !== proxyManager.getStatus().activeProvider ||
    ['pending', 'switching'].includes(state.proxySwitchStatus)
  );
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
    workerState.stopping = false;
    await repository.ensureSystemState();
    await repository.heartbeat(workerState.workerId, {
      workerProxyReady: false,
      workerProxyErrorCode: 'PROXY_INITIALIZING',
    });
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
 * 停止新领取并等待在途任务持久化完成。
 * @returns {Promise<void>}
 */
async function stop() {
  try {
    workerState.stopping = true;
    if (workerState.timer) clearInterval(workerState.timer);
    workerState.timer = null;
    await waitForIdle();
  } catch (error) {
    logger.error('等待爬虫在途任务结束失败', { error: error.message });
    throw error;
  }
}

/** 等待当前领取与执行完成，不启动新的调度轮次。 @returns {Promise<void>} */
async function waitForIdle() {
  try {
    await workerState.tickFinished;
    await Promise.allSettled([...workerState.inFlight.values()]);
  } catch (error) {
    logger.error('等待爬虫任务完成失败', { error: error.message });
    throw error;
  }
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
    isProcessing: workerState.running || workerState.inFlight.size > 0,
    inFlight: workerState.inFlight.size,
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
  waitForIdle,
  runOnce,
  processJob,
  getStatus,
  getPersistentState,
  reconcileProxyProvider,
  sanitizeProxySwitchError,
};
