const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { enqueueOrderReplay } = require('../services/orderMailLifecycleService');

const HTTP_ACCEPTED = 202;

/** POST /api/orders/:id/email-lifecycle/replay：刷新单个订单的全部邮件状态。 */
async function replayOrder(req, res) {
  try {
    const data = await enqueueOrderReplay(req.user, [req.params.id]);
    req.auditTarget = `订单邮件状态刷新；订单ID ${data.results[0].orderId}`;
    return res.status(HTTP_ACCEPTED).json({ success: true, data });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('订单邮件状态刷新失败', { orderId: req.params.id, errorType: error.name });
    throw ApiError.database('提交订单邮件状态刷新失败');
  }
}

/** POST /api/orders/email-lifecycle/replay：批量刷新所选订单的全部邮件状态。 */
async function replayOrders(req, res) {
  try {
    const data = await enqueueOrderReplay(req.user, req.body.orderIds);
    req.auditTarget = `订单邮件状态批量刷新；订单数 ${data.totals.orders}`;
    return res.status(HTTP_ACCEPTED).json({ success: true, data });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('订单邮件状态批量刷新失败', { errorType: error.name });
    throw ApiError.database('提交订单邮件状态批量刷新失败');
  }
}

module.exports = { replayOrder, replayOrders };
