const { Order } = require('../models');
const { scopeOrderWhere } = require('../services/orderAccessService');
const service = require('../services/pickupOcrService');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/** 在接收图片和计费调用之前校验订单范围。 */
async function authorize(req, _res, next) {
  try {
    const id = Number(req.params.orderId);
    if (!Number.isSafeInteger(id) || id <= 0) throw ApiError.badRequest('订单 ID 必须是正整数');
    if (!(await Order.findOne({ where: scopeOrderWhere(req.user, { id }), attributes: ['id'] })))
      throw ApiError.notFound('订单不存在或不可访问');
    next();
  } catch (error) {
    next(error instanceof ApiError ? error : ApiError.internal('订单范围校验失败'));
  }
}

/** 识别只返回候选，绑定仍需用户核对后单独提交。 */
async function recognize(req, res) {
  try {
    const data = await service.recognize(req.file);
    logger.info('取货图片 OCR 完成', {
      userId: req.user.id,
      orderId: req.params.orderId,
      candidateCount: data.candidates.length,
      requestId: data.requestId,
    });
    res.set('Cache-Control', 'no-store').json({ success: true, data });
  } catch (error) {
    logger.warn('取货图片 OCR 失败', {
      userId: req.user?.id,
      orderId: req.params.orderId,
      code: error.code,
    });
    throw error;
  } finally {
    if (req.file) req.file.buffer = null;
  }
}
module.exports = { authorize, recognize };
