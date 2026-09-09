const { Op } = require('sequelize');
const logger = require('../../utils/logger');

const {
  sequelize,
  Order,
  OrderRefreshSchedule,
  OrderRefreshJob,
  OrderRefreshBatch,
  OrderRefreshSystemState,
} = require('../../models');

const ACTIVE_JOB_STATUSES = ['pending', 'running'];
const ACTIVE_BATCH_STATUSES = ['pending', 'running'];

/**
 * 确保单例 Worker 状态存在。
 * @param {Object|null} transaction - Sequelize 事务
 * @returns {Promise<Object>} 系统状态
 */
async function ensureSystemState(transaction = null) {
  const [state] = await OrderRefreshSystemState.findOrCreate({
    where: { id: 1 },
    defaults: { id: 1, isPaused: false },
    transaction,
  });
  return state;
}

/**
 * 创建或更新订单调度状态。
 * @param {number} orderId - 订单 ID
 * @param {Object} values - 调度字段
 * @param {Object|null} transaction - Sequelize 事务
 * @returns {Promise<Object>} 调度记录
 */
async function upsertSchedule(orderId, values = {}, transaction = null) {
  const [schedule] = await OrderRefreshSchedule.findOrCreate({
    where: { orderId },
    defaults: { orderId, freshnessStatus: 'stale', ...values },
    transaction,
  });
  if (Object.keys(values).length > 0 && !schedule.isNewRecord) {
    await schedule.update(values, { transaction });
  }
  return schedule;
}

/**
 * 在订单行锁保护下创建或合并活动任务。
 * @param {number} orderId - 订单 ID
 * @param {Object} payload - 任务字段
 * @returns {Promise<{job:Object,created:boolean}>} 入队结果
 */
function enqueueJob(orderId, payload) {
  return sequelize.transaction(async transaction => {
    const order = await Order.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) return { job: null, created: false, reason: 'order_not_found' };

    await upsertSchedule(orderId, {}, transaction);
    const activeJob = await OrderRefreshJob.findOne({
      where: { orderId, status: { [Op.in]: ACTIVE_JOB_STATUSES } },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (activeJob) {
      const updates = {};
      if (activeJob.status === 'pending') {
        if (payload.priority > activeJob.priority) {
          updates.priority = payload.priority;
          updates.trigger = payload.trigger;
          updates.requestedBy = payload.requestedBy || activeJob.requestedBy;
        }
        if (new Date(payload.scheduledAt) < new Date(activeJob.scheduledAt)) {
          updates.scheduledAt = payload.scheduledAt;
        }
      }
      if (payload.batchId && !activeJob.batchId) updates.batchId = payload.batchId;
      if (Object.keys(updates).length > 0) await activeJob.update(updates, { transaction });
      return { job: activeJob, created: false, reason: 'merged' };
    }

    const job = await OrderRefreshJob.create(
      {
        orderId,
        trigger: payload.trigger,
        status: 'pending',
        priority: payload.priority,
        scheduledAt: payload.scheduledAt,
        batchId: payload.batchId || null,
        requestedBy: payload.requestedBy || null,
      },
      { transaction }
    );
    return { job, created: true };
  });
}

/**
 * 获取或创建唯一活动全量批次。
 * @param {number|null} requestedBy - 发起用户
 * @returns {Promise<{batch:Object,created:boolean}>} 批次结果
 */
function getOrCreateActiveBatch(requestedBy) {
  return sequelize.transaction(async transaction => {
    const state = await ensureSystemState(transaction);
    await state.reload({ transaction, lock: transaction.LOCK.UPDATE });
    const active = await OrderRefreshBatch.findOne({
      where: { status: { [Op.in]: ACTIVE_BATCH_STATUSES } },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (active) return { batch: active, created: false };
    const batch = await OrderRefreshBatch.create(
      { status: 'pending', requestedBy: requestedBy || null },
      { transaction }
    );
    return { batch, created: true };
  });
}

/**
 * 根据关联任务重新计算批次计数。
 * @param {number} batchId - 批次 ID
 * @returns {Promise<Object|null>} 更新后的批次
 */
function refreshBatchCounts(batchId) {
  if (!batchId) return null;
  return sequelize.transaction(async transaction => {
    const batch = await OrderRefreshBatch.findByPk(batchId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!batch) return null;
    const rows = await OrderRefreshJob.findAll({
      where: { batchId },
      attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['status'],
      raw: true,
      transaction,
    });
    const counts = Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
    const pendingCount = counts.pending || 0;
    const runningCount = counts.running || 0;
    const succeededCount = counts.succeeded || 0;
    const failedCount = counts.failed || 0;
    const jobSkippedCount = counts.skipped || 0;
    const skippedCount = Math.max(batch.skippedCount || 0, jobSkippedCount);
    const isComplete = pendingCount === 0 && runningCount === 0;
    await batch.update(
      {
        pendingCount,
        runningCount,
        succeededCount,
        failedCount,
        skippedCount,
        status: isComplete ? 'completed' : runningCount > 0 ? 'running' : 'pending',
        startedAt: batch.startedAt || (runningCount > 0 ? new Date() : null),
        finishedAt: isComplete ? new Date() : null,
      },
      { transaction }
    );
    return batch;
  });
}

/**
 * 恢复租约已过期的运行中任务。
 * @param {Date} now - 当前时间
 * @returns {Promise<number>} 恢复数量
 */
async function recoverExpiredLeases(now = new Date()) {
  const [count] = await OrderRefreshJob.update(
    { status: 'pending', leaseOwner: null, leaseExpiresAt: null, scheduledAt: now },
    {
      where: {
        status: 'running',
        leaseExpiresAt: { [Op.lt]: now },
      },
    }
  );
  return count;
}

/**
 * 使用 SKIP LOCKED 领取一批到期任务。
 * @param {string} workerId - Worker ID
 * @param {number} limit - 最大领取数
 * @param {number} leaseMs - 租约时长
 * @returns {Promise<Array<Object>>} 已领取任务
 */
function claimDueJobs(workerId, limit, leaseMs) {
  return sequelize.transaction(async transaction => {
    const now = new Date();
    const jobs = await OrderRefreshJob.findAll({
      where: { status: 'pending', scheduledAt: { [Op.lte]: now } },
      order: [
        ['priority', 'DESC'],
        ['scheduledAt', 'ASC'],
        ['id', 'ASC'],
      ],
      limit,
      transaction,
      lock: transaction.LOCK.UPDATE,
      skipLocked: true,
    });
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    for (const job of jobs) {
      await job.update(
        {
          status: 'running',
          leaseOwner: workerId,
          leaseExpiresAt,
          startedAt: now,
          attemptCount: job.attemptCount + 1,
        },
        { transaction }
      );
      await upsertSchedule(
        job.orderId,
        { lastAttemptAt: now, freshnessStatus: 'refreshing' },
        transaction
      );
    }
    return jobs;
  });
}

/**
 * 仅为本进程仍持有的在途任务续租，避免补位扫描回收仍在执行的任务。
 * @param {string} workerId - Worker 标识
 * @param {number[]} jobIds - 在途任务 ID
 * @param {number} leaseMs - 租约时长
 * @returns {Promise<number>} 续租数量
 */
async function renewActiveLeases(workerId, jobIds, leaseMs) {
  try {
    if (jobIds.length === 0) return 0;
    const [count] = await OrderRefreshJob.update(
      { leaseExpiresAt: new Date(Date.now() + leaseMs) },
      { where: { id: { [Op.in]: jobIds }, status: 'running', leaseOwner: workerId } }
    );
    return count;
  } catch (error) {
    logger.error('刷新任务续租失败', { workerId, jobCount: jobIds.length });
    throw error;
  }
}

/**
 * 查询到期的逐订单调度。
 * @param {number} limit - 查询上限
 * @param {Date} now - 当前时间
 * @returns {Promise<Array<Object>>} 调度记录
 */
function listDueSchedules(limit, now = new Date()) {
  return OrderRefreshSchedule.findAll({
    where: { nextAutoRefreshAt: { [Op.lte]: now } },
    include: [{ model: Order, as: 'order', required: true }],
    order: [['nextAutoRefreshAt', 'ASC']],
    limit,
  });
}

/**
 * 完成任务并同步调度状态。
 * @param {Object} job - 任务实例
 * @param {Object} outcome - 执行结果
 * @returns {Promise<void>}
 */
async function finishJob(job, outcome) {
  await sequelize.transaction(async transaction => {
    const lockedJob = await OrderRefreshJob.findByPk(job.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!lockedJob || lockedJob.status !== 'running' || lockedJob.leaseOwner !== job.leaseOwner)
      return;
    const now = new Date();
    await lockedJob.update(
      {
        status: outcome.skipped ? 'skipped' : outcome.success ? 'succeeded' : 'failed',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: outcome.errorCode || null,
        lastErrorMessage: outcome.errorMessage || null,
        finishedAt: now,
      },
      { transaction }
    );
    const schedule = await upsertSchedule(job.orderId, {}, transaction);
    let scheduleUpdate;
    if (outcome.skipped) {
      scheduleUpdate = { nextAutoRefreshAt: outcome.nextAutoRefreshAt };
    } else if (outcome.success) {
      scheduleUpdate = {
        lastSuccessAt: now,
        consecutiveFailures: 0,
        freshnessStatus: 'fresh',
        lastErrorCode: null,
        lastErrorMessage: null,
        nextAutoRefreshAt: outcome.nextAutoRefreshAt,
      };
    } else {
      scheduleUpdate = {
        lastFailureAt: now,
        consecutiveFailures: schedule.consecutiveFailures + 1,
        freshnessStatus: 'failed',
        lastErrorCode: outcome.errorCode,
        lastErrorMessage: outcome.errorMessage,
        nextAutoRefreshAt: outcome.nextAutoRefreshAt,
      };
    }
    await schedule.update(scheduleUpdate, { transaction });
  });
  await refreshBatchCounts(job.batchId);
}

/**
 * 更新 Worker 心跳。
 * @param {string} workerId - Worker ID
 * @returns {Promise<Object>} 系统状态
 */
async function heartbeat(workerId, runtime = {}) {
  const state = await ensureSystemState();
  await state.update({ workerId, heartbeatAt: new Date(), ...runtime });
  return state;
}

/**
 * 持久化暂停状态。
 * @param {string} reason - 暂停原因
 * @returns {Promise<Object>} 系统状态
 */
async function pause(reason) {
  const state = await ensureSystemState();
  await state.update({ isPaused: true, pauseReason: reason, pausedAt: new Date() });
  return state;
}

/**
 * 清除持久化暂停状态。
 * @param {number|null} userId - 操作用户
 * @returns {Promise<Object>} 系统状态
 */
async function resume(userId) {
  const state = await ensureSystemState();
  await state.update({
    isPaused: false,
    pauseReason: null,
    pausedAt: null,
    updatedBy: userId || null,
  });
  return state;
}

/**
 * 持久化管理员代理 Provider 切换请求。
 * @param {string} _providerName - 目标 Provider
 * @param {number|null} userId - 操作用户
 * @returns {Promise<Object>} 更新后的系统状态
 */
function requestProxyProviderSwitch(providerName, userId) {
  return sequelize.transaction(async transaction => {
    const state = await ensureSystemState(transaction);
    await state.reload({ transaction, lock: transaction.LOCK.UPDATE });
    await state.update(
      {
        requestedProxyProvider: providerName,
        proxySwitchStatus: 'pending',
        proxySwitchErrorCode: null,
        proxySwitchErrorMessage: null,
        proxySwitchRequestedAt: new Date(),
        updatedBy: userId || null,
      },
      { transaction }
    );
    return state;
  });
}

/**
 * 标记 Worker 已开始处理指定 Provider 切换。
 * @param {string} providerName - 目标 Provider
 * @returns {Promise<Object>} 更新后的系统状态
 */
async function startProxyProviderSwitch(_providerName) {
  const state = await ensureSystemState();
  await state.update({
    proxySwitchStatus: 'switching',
    proxySwitchErrorCode: null,
    proxySwitchErrorMessage: null,
  });
  return state;
}

/**
 * 记录 Worker 已成功切换 Provider。
 * @param {string} providerName - 已生效 Provider
 * @returns {Promise<Object>} 更新后的系统状态
 */
async function completeProxyProviderSwitch(providerName) {
  const state = await ensureSystemState();
  await state.update({
    activeProxyProvider: providerName,
    proxySwitchStatus: 'succeeded',
    proxySwitchErrorCode: null,
    proxySwitchErrorMessage: null,
    proxySwitchedAt: new Date(),
  });
  return state;
}

/**
 * 记录候选 Provider 切换失败，保留原活动 Provider。
 * @param {string} errorCode - 稳定错误码
 * @param {string} errorMessage - 脱敏错误摘要
 * @returns {Promise<Object>} 更新后的系统状态
 */
async function failProxyProviderSwitch(errorCode, errorMessage) {
  const state = await ensureSystemState();
  await state.update({
    proxySwitchStatus: 'failed',
    proxySwitchErrorCode: errorCode,
    proxySwitchErrorMessage: errorMessage,
  });
  return state;
}

/**
 * 在数据库行锁中预留一个全局请求时隙。
 * @param {number} intervalMs - 请求间隔
 * @returns {Promise<number>} 调用方需要等待的毫秒数
 */
function reserveRequestSlot(intervalMs) {
  return sequelize.transaction(async transaction => {
    const state = await ensureSystemState(transaction);
    await state.reload({ transaction, lock: transaction.LOCK.UPDATE });
    const nowMs = Date.now();
    const slotMs = Math.max(
      nowMs,
      state.nextRequestAt ? new Date(state.nextRequestAt).getTime() : 0
    );
    await state.update({ nextRequestAt: new Date(slotMs + intervalMs) }, { transaction });
    return Math.max(0, slotMs - nowMs);
  });
}

module.exports = {
  ACTIVE_JOB_STATUSES,
  ensureSystemState,
  upsertSchedule,
  enqueueJob,
  getOrCreateActiveBatch,
  refreshBatchCounts,
  recoverExpiredLeases,
  renewActiveLeases,
  claimDueJobs,
  listDueSchedules,
  finishJob,
  heartbeat,
  pause,
  resume,
  requestProxyProviderSwitch,
  startProxyProviderSwitch,
  completeProxyProviderSwitch,
  failProxyProviderSwitch,
  reserveRequestSlot,
};
