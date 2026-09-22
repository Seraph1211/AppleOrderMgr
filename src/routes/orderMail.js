const logger = require('../utils/logger');
const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission, requireAnyPermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const { OrderMailDelivery } = require('../models');
const service = require('../services/orderMailService');
const { parseOrderMail, mailText } = require('../services/orderMailContent');
const ApiError = require('../utils/ApiError');

const router = express.Router({ mergeParams: true });
router.use(requirePermission(PERMISSIONS.ORDERS_READ));
router.use(requireAnyPermission([PERMISSIONS.ORDER_MAIL_READ, PERMISSIONS.ORDER_MAIL_MANAGE]));
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
router.get(
  '/',
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        data: await service.listMessages(req.user, req.params.id, req.query),
      });
    } catch (error) {
      logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);
router.get(
  '/:messageId',
  asyncHandler(async (req, res) => {
    try {
      const message = await service.accessibleMessage(
        req.user,
        req.params.id,
        req.params.messageId,
        { content: true }
      );
      const parsed = await parseOrderMail(Buffer.from(message.rawContent, 'base64'));
      req.auditTarget = '订单邮件查看；订单ID ' + req.params.id + '；邮件ID ' + message.id;
      res.json({
        success: true,
        data: {
          ...service.messageSummary(message),
          lifecycle: await service.messageLifecycle(message.id),
          text: mailText(parsed),
        },
      });
    } catch (error) {
      logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);
router.get(
  '/:messageId/attachments/:index',
  asyncHandler(async (req, res) => {
    try {
      const message = await service.accessibleMessage(
        req.user,
        req.params.id,
        req.params.messageId,
        { content: true }
      );
      if (!/^[0-9]{1,4}$/.test(req.params.index)) throw ApiError.badRequest('附件编号无效');
      const parsed = await parseOrderMail(Buffer.from(message.rawContent, 'base64'));
      const attachment = parsed.attachments?.[Number(req.params.index)];
      if (!attachment) throw ApiError.notFound('附件不存在');
      req.auditTarget = '订单邮件附件下载；订单ID ' + req.params.id + '；邮件ID ' + message.id;
      res.attachment(String(attachment.filename || '附件').replace(/[\r\n/\\]/g, '_'));
      res.type('application/octet-stream');
      res.send(attachment.content);
    } catch (error) {
      logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);
router.get(
  '/:messageId/forwards',
  asyncHandler(async (req, res) => {
    try {
      await service.accessibleMessage(req.user, req.params.id, req.params.messageId);
      const deliveries = await OrderMailDelivery.findAll({
        where: { orderId: Number(req.params.id), messageId: req.params.messageId },
        order: [['createdAt', 'DESC']],
        limit: 50,
      });
      res.json({ success: true, data: deliveries.map(service.deliverySummary) });
    } catch (error) {
      logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);
router.post(
  '/:messageId/forward-batch',
  requireAnyPermission([PERMISSIONS.ORDER_MAIL_FORWARD, PERMISSIONS.ORDER_MAIL_MANAGE]),
  asyncHandler(async (req, res) => {
    try {
      const data = await service.enqueueBatchForward(
        req.user,
        req.params.id,
        req.params.messageId,
        req.body
      );
      req.auditTarget =
        '订单邮件批量转发；订单ID ' + req.params.id + '；任务数 ' + data.items.length;
      res.status(202).json({ success: true, data });
    } catch (error) {
      logger.warn('订单邮件批量转发未完成', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);
router.post(
  '/:messageId/forward',
  requireAnyPermission([PERMISSIONS.ORDER_MAIL_FORWARD, PERMISSIONS.ORDER_MAIL_MANAGE]),
  asyncHandler(async (req, res) => {
    try {
      const data = await service.enqueueForward(
        req.user,
        req.params.id,
        req.params.messageId,
        req.body
      );
      req.auditTarget = '订单邮件转发；订单ID ' + req.params.id + '；任务ID ' + data.id;
      res.status(202).json({ success: true, data });
    } catch (error) {
      logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);
router.post(
  '/:messageId/lifecycle/replay',
  requirePermission(PERMISSIONS.ORDER_MAIL_MANAGE),
  asyncHandler(async (req, res) => {
    try {
      const data = await require('../services/orderMailLifecycleService').enqueueReplay(
        req.user,
        req.params.id,
        req.params.messageId
      );
      req.auditTarget = `订单邮件重新解析；订单ID ${req.params.id}；邮件ID ${req.params.messageId}`;
      res.status(202).json({ success: true, data });
    } catch (error) {
      logger.warn('订单邮件重新解析未完成', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);
router.post(
  '/:messageId/lifecycle/review',
  requirePermission(PERMISSIONS.ORDER_MAIL_MANAGE),
  asyncHandler(async (req, res) => {
    try {
      const data = await require('../services/orderMailLifecycleService').reviewLifecycleEvent(
        req.user,
        req.params.id,
        req.params.messageId,
        req.body
      );
      req.auditTarget = `订单邮件人工核定；订单ID ${req.params.id}；邮件ID ${req.params.messageId}`;
      res.json({ success: true, data });
    } catch (error) {
      logger.warn('订单邮件人工核定未完成', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);

module.exports = router;
