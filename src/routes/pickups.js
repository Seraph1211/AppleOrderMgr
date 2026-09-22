const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const controller = require('../controllers/pickupController');

const router = express.Router();
router.get('/', requirePermission(PERMISSIONS.PICKUPS_READ), asyncHandler(controller.list));
router.get(
  '/export',
  requirePermission(PERMISSIONS.PICKUPS_EXPORT),
  asyncHandler(controller.exportList)
);
router.put(
  '/:orderId',
  requirePermission(PERMISSIONS.PICKUPS_EDIT),
  asyncHandler(controller.update)
);
router.get(
  '/:orderId/events',
  requirePermission(PERMISSIONS.PICKUPS_READ),
  asyncHandler(controller.events)
);
router.post(
  '/:orderId/evidence/prepare',
  requirePermission(PERMISSIONS.PICKUPS_EDIT),
  asyncHandler(controller.prepareEvidence)
);
router.post(
  '/:orderId/evidence/confirm',
  requirePermission(PERMISSIONS.PICKUPS_EDIT),
  asyncHandler(controller.confirmEvidence)
);
router.get(
  '/:orderId/evidence/:evidenceId',
  requirePermission(PERMISSIONS.PICKUPS_READ),
  asyncHandler(controller.readEvidence)
);
module.exports = router;
