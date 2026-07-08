/**
 * 收件人路由
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const controller = require('../controllers/recipientController');

const router = express.Router();

router.get('/', asyncHandler(controller.listRecipients));
router.get('/:id', asyncHandler(controller.getRecipientDetail));
router.post('/', asyncHandler(controller.createRecipient));
router.put('/:id', asyncHandler(controller.updateRecipient));
router.delete('/:id', asyncHandler(controller.deleteRecipient));

module.exports = router;
