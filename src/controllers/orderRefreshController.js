const { OrderRefreshSchedule } = require('../models');
const refreshJobService = require('../services/crawler/refreshJobService');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

function parseId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest(`${label} 必须是正整数`);
  return id;
}

function canReadOwnedResource(resource, user) {
  return user.role === 'admin' || resource.requestedBy === null || resource.requestedBy === user.id;
}

/** 查询订单刷新任务状态。 */
async function getJob(req, res) {
  try {
    const jobId = parseId(req.params.id, '任务 ID');
    const job = await refreshJobService.getJob(jobId);
    if (!job) throw ApiError.notFound('刷新任务不存在', { jobId });
    if (!canReadOwnedResource(job, req.user)) {
      throw new ApiError(403, 'FORBIDDEN', '无权查看该刷新任务');
    }
    const schedule = await OrderRefreshSchedule.findByPk(job.orderId);
    let refresh = null;
    if (schedule) {
      refresh = {
        freshnessStatus: schedule.freshnessStatus,
        lastAttemptAt: schedule.lastAttemptAt,
        lastSuccessAt: schedule.lastSuccessAt,
        lastFailureAt: schedule.lastFailureAt,
      };
    }
    return res.json({
      success: true,
      data: {
        id: job.id,
        orderId: job.orderId,
        trigger: job.trigger,
        status: job.status,
        priority: job.priority,
        scheduledAt: job.scheduledAt,
        attemptCount: job.attemptCount,
        lastErrorCode: job.lastErrorCode,
        lastErrorMessage: job.lastErrorMessage,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        refresh,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('查询刷新任务失败', { jobId: req.params.id, error: error.message });
    throw ApiError.database('查询刷新任务失败', { reason: error.message });
  }
}

/** 查询刷新全部批次状态。 */
async function getBatch(req, res) {
  try {
    const batchId = parseId(req.params.id, '批次 ID');
    const batch = await refreshJobService.getBatch(batchId);
    if (!batch) throw ApiError.notFound('刷新批次不存在', { batchId });
    if (!canReadOwnedResource(batch, req.user)) {
      throw new ApiError(403, 'FORBIDDEN', '无权查看该刷新批次');
    }
    return res.json({
      success: true,
      data: {
        id: batch.id,
        status: batch.status,
        total: batch.totalCount,
        pending: batch.pendingCount,
        running: batch.runningCount,
        succeeded: batch.succeededCount,
        failed: batch.failedCount,
        skipped: batch.skippedCount,
        startedAt: batch.startedAt,
        finishedAt: batch.finishedAt,
        createdAt: batch.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('查询刷新批次失败', { batchId: req.params.id, error: error.message });
    throw ApiError.database('查询刷新批次失败', { reason: error.message });
  }
}

module.exports = { getJob, getBatch };
