const paymentDispatchService = require('../services/paymentDispatchService');
const logger = require('../utils/logger');

/** 查询调度概览。 */
async function getOverview(_req, res) {
  return res.json({ success: true, data: await paymentDispatchService.getDispatchOverview() });
}

/** 查询全局付款任务。 */
async function listTasks(req, res) {
  return res.json({
    success: true,
    data: await paymentDispatchService.listDispatchTasks(req.query),
  });
}

/** 更新全局调度配置。 */
async function updateSettings(req, res) {
  const data = await paymentDispatchService.updateDispatchSettings(req.body, req.user.id);
  return res.json({ success: true, data });
}

/** 更新人员接单配置。 */
async function updateStaffSettings(req, res) {
  const data = await paymentDispatchService.updateStaffSettings(
    Number(req.params.userId),
    req.body,
    req.user.id
  );
  return res.json({ success: true, data });
}

/** 原子保存多个人员配置。 */
async function updateStaffSettingsBatch(req, res) {
  try {
    const data = await paymentDispatchService.updateStaffSettingsBatch(req.body.staff, req.user.id);
    return res.json({ success: true, data });
  } catch (error) {
    logger.error('批量更新人员配置失败', { actorUserId: req.user.id, error: error.message });
    throw error;
  }
}

/** 手动分配或转派任务。 */
async function assignTask(req, res) {
  const data = await paymentDispatchService.assignTask(
    Number(req.params.id),
    { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey },
    req.user.id
  );
  return res.json({ success: true, data });
}

/** 原子批量分配或转派任务。 */
async function assignTasks(req, res) {
  const data = await paymentDispatchService.assignTasks(
    { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey },
    req.user.id
  );
  return res.json({ success: true, data });
}

/** 提交单个任务官网刷新。 */
async function refreshTask(req, res) {
  const data = await paymentDispatchService.refreshTask(Number(req.params.id), req.user.id);
  return res.status(202).json({ success: true, message: '刷新任务已提交', data });
}

/** 提交选中任务批量官网刷新。 */
async function refreshTasks(req, res) {
  const data = await paymentDispatchService.refreshTasks(req.body.taskIds, req.user.id);
  return res.status(202).json({ success: true, message: '批量刷新任务已提交', data });
}

/** 重开已完成任务。 */
async function reopenTask(req, res) {
  const data = await paymentDispatchService.reopenTask(
    Number(req.params.id),
    { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey },
    req.user.id
  );
  return res.json({ success: true, data });
}

/** 立即执行一次调度扫描。 */
async function runScan(req, res) {
  const data = await paymentDispatchService.runDispatchScan(Number(req.body.limit) || 500);
  return res.json({ success: true, data });
}

module.exports = {
  getOverview,
  listTasks,
  updateSettings,
  updateStaffSettings,
  updateStaffSettingsBatch,
  assignTasks,
  assignTask,
  refreshTasks,
  refreshTask,
  reopenTask,
  runScan,
};
