const logger = require('../utils/logger');
const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireRole, requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const controller = require('../controllers/paymentDispatchController');
const tagRules = require('../controllers/paymentTagRuleController');

const router = express.Router();

router.use(requireRole(['admin']));
router.get(
  '/tag-rules',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE),
  asyncHandler(tagRules.list)
);
router.post(
  '/tag-rules',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE),
  asyncHandler(tagRules.create)
);
router.put(
  '/tag-rules/:id',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE),
  asyncHandler(tagRules.update)
);
router.delete(
  '/tag-rules/:id',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE),
  asyncHandler(tagRules.remove)
);
router.get(
  '/pending-overview',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_READ),
  asyncHandler(controller.getPendingOverview)
);
router.get(
  '/overview',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_READ),
  asyncHandler(controller.getOverview)
);
router.get(
  '/tasks',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_READ),
  asyncHandler(controller.listTasks)
);
router.put(
  '/settings',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE),
  asyncHandler(controller.updateSettings)
);
router.put(
  '/staff',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE),
  asyncHandler(controller.updateStaffSettingsBatch)
);
router.put(
  '/staff/:userId',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_CONFIGURE),
  asyncHandler(controller.updateStaffSettings)
);
router.put(
  '/tasks/assignee',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_ASSIGN),
  asyncHandler(controller.assignTasks)
);
router.post(
  '/tasks/refresh',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_ASSIGN),
  asyncHandler(controller.refreshTasks)
);
router.put(
  '/tasks/:id/assignee',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_ASSIGN),
  asyncHandler(controller.assignTask)
);
router.post(
  '/tasks/:id/refresh',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_ASSIGN),
  asyncHandler(controller.refreshTask)
);
router.post(
  '/tasks/:id/reopen',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_CORRECT),
  asyncHandler(controller.reopenTask)
);
router.post(
  '/scan',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_ASSIGN),
  asyncHandler(controller.runScan)
);

router.get(
  '/tasks/:id/payment-link',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_READ),
  asyncHandler(controller.getPaymentLink)
);

router.get(
  '/tasks/:id/payment-code',
  requirePermission(PERMISSIONS.PAYMENT_DISPATCH_READ),
  asyncHandler(async (req, res) => {
    try {
      const data = await require('../services/paymentCodeService').getPaymentCode(
        Number(req.params.id),
        req.user.id,
        false
      );
      res.set('Cache-Control', 'no-store').json({ success: true, data });
    } catch (error) {
      logger.debug('付款码或采集更新操作未完成', {
        errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
      });
      throw error;
    }
  })
);
module.exports = router;
