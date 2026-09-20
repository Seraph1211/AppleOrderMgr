const express = require('express');
const { requireRole, requirePermission } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/wecomNotificationService');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const router = express.Router();
router.use(requireRole(['admin']));
router.use(requirePermission('wecom.read'));
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const respond = work =>
  asyncHandler(async (req, res) => {
    try {
      res.json({ success: true, data: await work(req) });
    } catch (error) {
      logger.debug('企微通知接口失败', { errorType: error.name });
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'WECOM_OPERATION_FAILED', '企微通知操作失败，请稍后重试');
    }
  });
router.get(
  '/settings',
  respond(() => service.settings())
);
router.put(
  '/settings',
  requirePermission('wecom.configure'),
  respond(req => service.saveSettings(req.user.id, req.body))
);
router.post(
  '/test',
  requirePermission('wecom.configure'),
  respond(req => service.queueTest(req.user.id, req.body))
);
router.get(
  '/deliveries',
  respond(req => service.history(req.query))
);
router.post(
  '/deliveries/:id/retry',
  requirePermission('wecom.retry'),
  respond(req => service.retry(req.user.id, req.params.id, req.body))
);
module.exports = router;
