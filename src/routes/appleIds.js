/**
 * Apple ID 路由
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const controller = require('../controllers/appleIdController');

const router = express.Router();

/** 所有响应均禁用缓存，包括权限与输入校验失败。 */
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

router.get(
  '/statistics',
  noStore,
  requirePermission(PERMISSIONS.APPLE_IDS_READ),
  asyncHandler(controller.getAppleIdStatistics)
);
router.get(
  '/selection-ids',
  noStore,
  requirePermission(PERMISSIONS.APPLE_IDS_READ),
  asyncHandler(controller.getAppleIdSelectionIds)
);
router.get(
  '/:id/bindings',
  requirePermission(PERMISSIONS.RECIPIENTS_READ),
  requirePermission(PERMISSIONS.APPLE_IDS_READ),
  asyncHandler(require('../controllers/recipientController').listBindings)
);

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
  '/batch-update',
  requirePermission(PERMISSIONS.APPLE_IDS_EDIT),
  asyncHandler(controller.batchUpdateAppleIds)
);
router.post(
  '/copy-import',
  (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  },
  requirePermission(PERMISSIONS.APPLE_IDS_READ),
  asyncHandler(controller.copyImportAppleIds)
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
