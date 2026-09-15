const logger = require('../utils/logger');
const express = require('express');
const { requirePermission } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/monitorService');
const notifications = require('../services/monitorNotificationService');
const router = express.Router();
router.use(requirePermission('monitor.manage'));
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
function respond(work) {
  return asyncHandler(async (req, res) => {
    try {
      res.json({ success: true, data: await work(req) });
    } catch (error) {
      logger.debug('监控操作未完成', { errorCode: error.code || error.name });
      throw error;
    }
  });
}
router.get(
  '/overview',
  respond(() => service.overview())
);
router.get(
  '/traffic',
  respond(req => service.traffic(req.query))
);
router.get(
  '/instances/:id/history',
  respond(req => service.history(req.params.id, Number(req.query.page || 1)))
);
router.post(
  '/instances/:id/actions',
  respond(req => service.act(req.user.id, req.params.id, req.body))
);
router.post(
  '/rules/test',
  respond(req => service.testRule(req.body))
);
router.post(
  '/rules',
  respond(req => service.saveRule(req.user.id, null, req.body))
);
router.put(
  '/rules/:id',
  respond(req => service.saveRule(req.user.id, req.params.id, req.body))
);
router.put(
  '/notifications/settings',
  respond(req => notifications.saveSettings(req.user.id, req.body))
);
router.post(
  '/notifications/test',
  respond(() => notifications.queueTest())
);
router.get(
  '/notifications/history',
  respond(req => notifications.history(Number(req.query.page || 1)))
);
module.exports = router;
