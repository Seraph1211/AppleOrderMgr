const paymentTaskService = require('../services/paymentTaskService');
const payerService = require('../services/payerService');
const { PERMISSIONS } = require('../constants/business');

/** 查询本人付款任务。 */
async function listOwnTasks(req, res) {
  const data = await paymentTaskService.listOwnTasks(req.user.id, req.query);
  return res.json({ success: true, data });
}

/** 查询本人任务详情。 */
async function getOwnTask(req, res) {
  const data = await paymentTaskService.getOwnTask(Number(req.params.id), req.user.id);
  return res.json({ success: true, data });
}

/** 原子保存本人任务状态、备注和／或付款人。 */
async function updateOwnTask(req, res) {
  const data = await paymentTaskService.updateOwnTask(
    Number(req.params.id),
    { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey },
    req.user.id,
    {
      canHandle: req.user.permissions.includes(PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN),
      canEditPayer: req.user.permissions.includes(PERMISSIONS.PAYMENT_TASKS_PAYER_EDIT_OWN),
    }
  );
  return res.json({ success: true, data });
}

/** 更新本人任务订单的付款人。 */
async function assignOwnTaskPayer(req, res) {
  const task = await paymentTaskService.getOwnTask(Number(req.params.id), req.user.id);
  const data = await payerService.assignOrderPayer(
    task.orderId,
    { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey },
    req.user.id,
    { assigneeUserId: req.user.id }
  );
  return res.json({ success: true, data });
}

/** 复制本人任务关联订单链接。 */
async function getOwnPaymentLink(req, res) {
  const data = await paymentTaskService.getOwnPaymentLink(Number(req.params.id), req.user.id);
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, data });
}

/** 提交本人任务订单刷新。 */
async function refreshOwnTask(req, res) {
  const data = await paymentTaskService.refreshOwnTask(Number(req.params.id), req.user.id);
  return res.status(202).json({ success: true, data });
}

/** 查询本人任务关联订单的刷新进度。 */
async function getOwnRefreshJob(req, res) {
  const data = await paymentTaskService.getOwnRefreshJob(
    Number(req.params.id),
    Number(req.params.jobId),
    req.user.id
  );
  return res.json({ success: true, data });
}

module.exports = {
  listOwnTasks,
  getOwnTask,
  updateOwnTask,
  assignOwnTaskPayer,
  getOwnPaymentLink,
  refreshOwnTask,
  getOwnRefreshJob,
};
