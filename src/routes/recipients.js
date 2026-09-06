/**
 * 收件人路由
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const controller = require('../controllers/recipientController');

const router = express.Router();

router.get('/', asyncHandler(controller.listRecipients));
router.get(
  '/export',
  requirePermission(PERMISSIONS.EXPORT),
  asyncHandler(controller.exportRecipients)
);
router.get('/:id', asyncHandler(controller.getRecipientDetail));
router.post('/', requirePermission(PERMISSIONS.WRITE), asyncHandler(controller.createRecipient));
router.post(
  '/batch-generate-contact',
  requirePermission(PERMISSIONS.WRITE),
  asyncHandler(controller.batchGenerateContact)
);
router.post(
  '/batch-generate-address',
  requirePermission(PERMISSIONS.WRITE),
  asyncHandler(controller.batchGenerateAddress)
);
router.post(
  '/bind-apple-ids',
  requirePermission(PERMISSIONS.WRITE),
  asyncHandler(controller.batchBindAppleIds)
);
router.put('/:id', requirePermission(PERMISSIONS.WRITE), asyncHandler(controller.updateRecipient));
router.delete(
  '/:id',
  requirePermission(PERMISSIONS.DELETE),
  asyncHandler(controller.deleteRecipient)
);

module.exports = router;
