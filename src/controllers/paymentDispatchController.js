const paymentDispatchService = require('../services/paymentDispatchService');
const logger = require('../utils/logger');

/** 查询全局待付款订单数量。 */
async function getPendingOverview(_req, res) {
  try {
    return res.json({ success: true, data: await paymentDispatchService.getPendingOverview() });
  } catch (error) {
    logger.error('查询待付款概览失败', { error: error.message });
    throw error;
  }
}

/** 按权限读取调度任务付款链接。 */
async function getPaymentLink(req, res) {
  try {
    const data = await paymentDispatchService.getPaymentLink(Number(req.params.id), req.user.id);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data });
  } catch (error) {
    logger.error('读取调度订单信息失败', { actorUserId: req.user.id, error: error.message });
    throw error;
  }
}

/** 按权限读取调度任务的 AOS 支付宝付款链接。 */
async function getAlipayPaymentLink(req, res) {
  try {
    const data = await require('../services/alipayPaymentLinkService').getDispatchAlipayPaymentLink(
      Number(req.params.id),
      req.user.id
    );
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, data });
  } catch (error) {
    logger.debug('调度支付宝付款链接读取未完成', {
      actorUserId: req.user.id,
      errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
    });
    throw error;
  }
}

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

/** 只读检查选中任务与接收人，保留权限边界。 */
async function previewAssignment(req, res) {
  try {
    return res.json({
      success: true,
      data: await paymentDispatchService.previewAssignment(req.body),
    });
  } catch (error) {
    logger.warn('付款分配请求未完成', {
      actorUserId: req.user.id,
      requestId: req.requestId,
      errorCode: error.code || 'ASSIGNMENT_FAILED',
    });
    throw error;
  }
}

/** 手动分配或转派任务，传递可信请求编号用于失败追溯。 */
async function assignTask(req, res) {
  try {
    const data = await paymentDispatchService.assignTask(
      Number(req.params.id),
      { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey },
      req.user.id,
      { requestId: req.requestId }
    );
    return res.json({ success: true, data });
  } catch (error) {
    logger.warn('付款分配请求未完成', {
      actorUserId: req.user.id,
      requestId: req.requestId,
      errorCode: error.code || 'ASSIGNMENT_FAILED',
    });
    throw error;
  }
}

/** 原子批量分配或转派任务。 */
async function assignTasks(req, res) {
  try {
    const data = await paymentDispatchService.assignTasks(
      { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey },
      req.user.id,
      { requestId: req.requestId }
    );
    return res.json({ success: true, data });
  } catch (error) {
    logger.warn('付款分配请求未完成', {
      actorUserId: req.user.id,
      requestId: req.requestId,
      errorCode: error.code || 'ASSIGNMENT_FAILED',
    });
    throw error;
  }
}

/** 管理员修改付款任务处理备注。 */
async function updateTaskNotes(req, res) {
  const data = await paymentDispatchService.updateTaskNotes(
    Number(req.params.id),
    { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey },
    req.user.id
  );
  return res.json({ success: true, data });
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
  previewAssignment,
  getPaymentLink,
  getAlipayPaymentLink,
  getPendingOverview,
  getOverview,
  listTasks,
  updateSettings,
  updateStaffSettings,
  updateStaffSettingsBatch,
  assignTasks,
  assignTask,
  updateTaskNotes,
  reopenTask,
  runScan,
};
