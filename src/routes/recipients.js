/**
 * 收件人路由
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const controller = require('../controllers/recipientController');

const router = express.Router();

router.get('/', asyncHandler(controller.listRecipients));
router.get('/export', asyncHandler(controller.exportRecipients));
router.get('/:id', asyncHandler(controller.getRecipientDetail));
router.post('/', asyncHandler(controller.createRecipient));
router.post('/batch-generate-contact', asyncHandler(controller.batchGenerateContact));
router.post('/batch-generate-address', asyncHandler(controller.batchGenerateAddress));
router.post('/bind-apple-ids', asyncHandler(controller.batchBindAppleIds));
router.put('/:id', asyncHandler(controller.updateRecipient));
router.delete('/:id', asyncHandler(controller.deleteRecipient));

module.exports = router;
