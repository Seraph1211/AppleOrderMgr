/**
 * 收件人路由
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, requireRole } = require('../middleware/authMiddleware');
const controller = require('../controllers/recipientController');

const router = express.Router();

// 所有接口都需要认证
router.use(authenticate);

router.get('/', asyncHandler(controller.listRecipients));
router.get('/export', asyncHandler(controller.exportRecipients));
router.get('/:id', asyncHandler(controller.getRecipientDetail));
router.post('/', asyncHandler(controller.createRecipient));
router.post('/batch-generate-contact', asyncHandler(controller.batchGenerateContact));
router.post('/batch-generate-address', asyncHandler(controller.batchGenerateAddress));
router.post('/bind-apple-ids', asyncHandler(controller.batchBindAppleIds));
router.put('/:id', asyncHandler(controller.updateRecipient));
router.delete('/:id', requireRole(['admin']), asyncHandler(controller.deleteRecipient));

module.exports = router;
