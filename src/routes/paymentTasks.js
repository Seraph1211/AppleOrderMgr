const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAnyPermission, requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const controller = require('../controllers/paymentTaskController');

const router = express.Router();

router.get(
  '/',
  requirePermission(PERMISSIONS.PAYMENT_TASKS_READ_OWN),
  asyncHandler(controller.listOwnTasks)
);
router.get(
  '/:id',
  requirePermission(PERMISSIONS.PAYMENT_TASKS_READ_OWN),
  asyncHandler(controller.getOwnTask)
);
router.put(
  '/:id',
  requireAnyPermission([
    PERMISSIONS.PAYMENT_TASKS_HANDLE_OWN,
    PERMISSIONS.PAYMENT_TASKS_PAYER_EDIT_OWN,
  ]),
  asyncHandler(controller.updateOwnTask)
);
router.put(
  '/:id/payer',
  requirePermission(PERMISSIONS.PAYMENT_TASKS_PAYER_EDIT_OWN),
  asyncHandler(controller.assignOwnTaskPayer)
);
router.get(
  '/:id/payment-link',
  requirePermission(PERMISSIONS.PAYMENT_TASKS_LINK_READ_OWN),
  asyncHandler(controller.getOwnPaymentLink)
);
router.post(
  '/:id/refresh',
  requirePermission(PERMISSIONS.PAYMENT_TASKS_REFRESH_OWN),
  asyncHandler(controller.refreshOwnTask)
);
router.get(
  '/:id/refresh/:jobId',
  requirePermission(PERMISSIONS.PAYMENT_TASKS_REFRESH_OWN),
  asyncHandler(controller.getOwnRefreshJob)
);

module.exports = router;
