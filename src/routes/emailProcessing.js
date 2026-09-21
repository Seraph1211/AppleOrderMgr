/**
 * 逐用户权限控制的邮件处理路由。
 * @module routes/emailProcessing
 */

const express = require('express');

const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const emailProcessingController = require('../controllers/emailProcessingController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get(
  '/',
  requirePermission(PERMISSIONS.EMAIL_READ),
  asyncHandler(emailProcessingController.listRecords)
);
router.get(
  '/metrics',
  requirePermission(PERMISSIONS.EMAIL_READ),
  asyncHandler(emailProcessingController.getMetrics)
);
router.post(
  '/batch-reparse',
  requirePermission(PERMISSIONS.EMAIL_PROCESS),
  asyncHandler(emailProcessingController.batchReparse)
);
router.get(
  '/:id',
  requirePermission(PERMISSIONS.EMAIL_CONTENT_READ),
  asyncHandler(emailProcessingController.getRecord)
);
router.post(
  '/:id/reparse',
  requirePermission(PERMISSIONS.EMAIL_PROCESS),
  asyncHandler(emailProcessingController.reparseRecord)
);
router.put(
  '/:id/draft',
  requirePermission(PERMISSIONS.EMAIL_PROCESS),
  asyncHandler(emailProcessingController.saveDraft)
);
router.post(
  '/:id/ingest',
  requirePermission(PERMISSIONS.EMAIL_PROCESS),
  asyncHandler(emailProcessingController.ingestRecord)
);
router.post(
  '/:id/resolve',
  requirePermission(PERMISSIONS.EMAIL_PROCESS),
  asyncHandler(emailProcessingController.resolveRecord)
);

module.exports = router;
