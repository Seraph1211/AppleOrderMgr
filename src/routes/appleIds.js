/**
 * Apple ID 路由
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const controller = require('../controllers/appleIdController');

const router = express.Router();

router.get(
  '/',
  requirePermission(PERMISSIONS.APPLE_IDS_READ),
  asyncHandler(controller.listAppleIds)
);
router.get(
  '/:id',
  requirePermission(PERMISSIONS.APPLE_IDS_READ),
  asyncHandler(controller.getAppleIdDetail)
);
router.post(
  '/',
  requirePermission(PERMISSIONS.APPLE_IDS_CREATE),
  asyncHandler(controller.createAppleId)
);
router.put(
  '/:id',
  requirePermission(PERMISSIONS.APPLE_IDS_EDIT),
  asyncHandler(controller.updateAppleId)
);
router.delete(
  '/:id',
  requirePermission(PERMISSIONS.APPLE_IDS_DELETE),
  asyncHandler(controller.deleteAppleId)
);

module.exports = router;
