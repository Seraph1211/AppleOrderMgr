const { Op } = require('sequelize');

const { Order, OrderRefreshJob, OrderRefreshBatch } = require('../../models');
const logger = require('../../utils/logger');
const repository = require('./refreshJobRepository');
const {
  AUTO_REFRESH_INTERVAL_MS,
  getNextAutoRefreshAt,
  getRefreshPriority,
  isAutoRefreshEligible,
} = require('./refreshPolicy');

/**
 * 提交或合并一个订单刷新任务。
 * @param {number} orderId - 订单 ID
 * @param {Object} options - 触发上下文
 * @returns {Promise<Object>} 入队结果
 */
async function enqueueOrderRefresh(orderId, options = {}) {
  try {
    const trigger = options.trigger || 'manual_single';
    const scheduledAt = options.scheduledAt || new Date();
    const overdue = trigger === 'auto' && scheduledAt <= new Date();
    return await repository.enqueueJob(orderId, {
      trigger,
      priority: getRefreshPriority(trigger, overdue),
      scheduledAt,
      requestedBy: options.requestedBy || null,
      batchId: options.batchId || null,
    });
  } catch (error) {
    logger.error('提交订单刷新任务失败', { orderId, error: error.message });
    throw error;
  }
}

/**
 * 邮件创建订单后提交首次刷新任务和自动调度。
 * @param {Object} order - 新订单
 * @returns {Promise<Object|null>} 入队结果
 */
async function enqueueInitialRefresh(order) {
  try {
    if (!order?.id || !order.orderUrl) return null;
    await repository.upsertSchedule(order.id, {
      nextAutoRefreshAt: new Date(),
      freshnessStatus: 'stale',
    });
    return enqueueOrderRefresh(order.id, { trigger: 'auto' });
  } catch (error) {
    logger.error('提交订单首次刷新任务失败', { orderId: order?.id, error: error.message });
    throw error;
  }
}

/**
 * 为指定订单集合异步提交任务。
 * @param {number[]} orderIds - 订单 ID
 * @param {Object} options - 触发上下文
 * @returns {Promise<Object>} 汇总结果
 */
async function enqueueMany(orderIds, options = {}) {
  const uniqueIds = [...new Set(orderIds)];
  const results = [];
  for (const orderId of uniqueIds) {
    const result = await enqueueOrderRefresh(orderId, options);
    results.push({
      orderId,
      jobId: result.job?.id || null,
      created: result.created,
      reason: result.reason || null,
    });
  }
  return {
    total: uniqueIds.length,
    created: results.filter(result => result.created).length,
    merged: results.filter(result => !result.created && result.jobId).length,
    missing: results.filter(result => !result.jobId).length,
    results,
  };
}

/**
 * 创建或复用刷新全部批次并提交所有合法订单。
 * @param {number|null} requestedBy - 发起用户
 * @returns {Promise<Object>} 批次提交结果
 */
async function enqueueRefreshAll(requestedBy) {
  try {
    const { batch, created } = await repository.getOrCreateActiveBatch(requestedBy);
    if (!created) return { batch, created: false };

    const orders = await Order.findAll({
      where: { orderUrl: { [Op.ne]: null } },
      attributes: ['id'],
      order: [['id', 'ASC']],
    });
    let skippedCount = 0;
    for (const order of orders) {
      const result = await enqueueOrderRefresh(order.id, {
        trigger: 'manual_all',
        requestedBy,
        batchId: batch.id,
      });
      if (!result.job || result.job.batchId !== batch.id) skippedCount++;
    }
    await batch.update({ totalCount: orders.length, skippedCount });
    await repository.refreshBatchCounts(batch.id);
    await batch.reload();
    return { batch, created: true };
  } catch (error) {
    logger.error('提交刷新全部批次失败', { requestedBy, error: error.message });
    throw error;
  }
}

/**
 * 兼容旧页面刷新入口，不再提交自动任务。
 * @param {number[]} orderIds - 当前页面订单 ID
 * @param {number|null} requestedBy - 当前用户
 * @returns {Promise<Object>} 提交汇总
 */
function enqueuePageOpenRefresh(_orderIds, _requestedBy) {
  // 保留旧客户端契约，但页面打开不再访问官网。
  return Promise.resolve({ total: 0, created: 0, merged: 0, missing: 0, results: [] });
}

/**
 * 把到期调度转换为去重任务并推进下一调度时间。
 * @param {number} limit - 单次扫描上限
 * @returns {Promise<Object>} 扫描结果
 */
async function enqueueDueAutoJobs(limit = 500) {
  try {
    const schedules = await repository.listDueSchedules(limit);
    let eligible = 0;
    for (const schedule of schedules) {
      if (!isAutoRefreshEligible(schedule.order)) {
        await schedule.update({ nextAutoRefreshAt: null });
        continue;
      }
      eligible++;
      await enqueueOrderRefresh(schedule.orderId, { trigger: 'auto' });
      await schedule.update({
        nextAutoRefreshAt: new Date(Date.now() + AUTO_REFRESH_INTERVAL_MS),
      });
    }
    return { scanned: schedules.length, eligible };
  } catch (error) {
    logger.error('创建到期自动刷新任务失败', { error: error.message });
    throw error;
  }
}

/**
 * 根据刷新结果计算下一次自动时间。
 * @param {number} orderId - 订单 ID
 * @returns {Promise<Date|null>} 下一次自动时间
 */
async function calculateNextRefresh(orderId) {
  const order = await Order.findByPk(orderId, {
    attributes: [
      'id',
      'orderUrl',
      'status',
      'paymentStatus',
      'validationStatus',
      'validationIssues',
      'officialAllItemsTerminal',
      'autoRefreshEnabled',
      'officialPaymentExpiresAt',
      'officialOrderCreatedAt',
      'orderDate',
      'createdAt',
    ],
  });
  return order ? getNextAutoRefreshAt(order) : null;
}

/**
 * 查询单个任务及其调度状态。
 * @param {number} jobId - 任务 ID
 * @returns {Promise<Object|null>} 任务
 */
function getJob(jobId) {
  return OrderRefreshJob.findByPk(jobId);
}

/**
 * 查询批次。
 * @param {number} batchId - 批次 ID
 * @returns {Promise<Object|null>} 批次
 */
async function getBatch(batchId) {
  await repository.refreshBatchCounts(batchId);
  return OrderRefreshBatch.findByPk(batchId);
}

module.exports = {
  enqueueOrderRefresh,
  enqueueInitialRefresh,
  enqueueMany,
  enqueueRefreshAll,
  enqueuePageOpenRefresh,
  enqueueDueAutoJobs,
  calculateNextRefresh,
  getJob,
  getBatch,
};
