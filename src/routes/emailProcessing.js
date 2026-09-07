/**
 * 管理员邮件处理路由。
 * @module routes/emailProcessing
 */

const express = require('express');

const { requireRole } = require('../middleware/authMiddleware');
const emailProcessingController = require('../controllers/emailProcessingController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.use(requireRole(['admin']));
router.get('/', asyncHandler(emailProcessingController.listRecords));
router.get('/metrics', asyncHandler(emailProcessingController.getMetrics));
router.post('/batch-reparse', asyncHandler(emailProcessingController.batchReparse));
router.get('/:id', asyncHandler(emailProcessingController.getRecord));
router.post('/:id/reparse', asyncHandler(emailProcessingController.reparseRecord));
router.put('/:id/draft', asyncHandler(emailProcessingController.saveDraft));
router.post('/:id/ingest', asyncHandler(emailProcessingController.ingestRecord));
router.post('/:id/resolve', asyncHandler(emailProcessingController.resolveRecord));

module.exports = router;
