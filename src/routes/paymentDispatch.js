const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireRole, requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const controller = require('../controllers/paymentDispatchController');

const router = express.Router();

router.use(requireRole(['admin']));
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

module.exports = router;
