/**
 * 收件人路由
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const controller = require('../controllers/recipientController');

const router = express.Router();

router.get(
  '/',
  requirePermission(PERMISSIONS.RECIPIENTS_READ),
  asyncHandler(controller.listRecipients)
);
router.get(
  '/export',
  requirePermission(PERMISSIONS.RECIPIENTS_EXPORT),
  asyncHandler(controller.exportRecipients)
);
router.get(
  '/:id',
  requirePermission(PERMISSIONS.RECIPIENTS_READ),
  asyncHandler(controller.getRecipientDetail)
);
router.post(
  '/',
  requirePermission(PERMISSIONS.RECIPIENTS_CREATE),
  asyncHandler(controller.createRecipient)
);
router.post(
  '/batch-generate-contact',
  requirePermission(PERMISSIONS.RECIPIENTS_GENERATE_CONTACT),
  asyncHandler(controller.batchGenerateContact)
);
router.post(
  '/batch-generate-address',
  requirePermission(PERMISSIONS.RECIPIENTS_GENERATE_ADDRESS),
  asyncHandler(controller.batchGenerateAddress)
);
router.post(
  '/bind-apple-ids',
  requirePermission(PERMISSIONS.RECIPIENTS_BIND_APPLE_IDS),
  asyncHandler(controller.batchBindAppleIds)
);
router.put(
  '/:id',
  requirePermission(PERMISSIONS.RECIPIENTS_EDIT),
  asyncHandler(controller.updateRecipient)
);
router.delete(
  '/:id',
  requirePermission(PERMISSIONS.RECIPIENTS_DELETE),
  asyncHandler(controller.deleteRecipient)
);

module.exports = router;
