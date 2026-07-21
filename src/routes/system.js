/**
 * 系统运行状态与日志路由
 * @module routes/system
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, requireRole } = require('../middleware/authMiddleware');
const systemController = require('../controllers/systemController');

const router = express.Router();

router.use(authenticate);

router.get('/logs', asyncHandler(systemController.listSystemLogs));
router.get('/auto-refresh', asyncHandler(systemController.getAutoRefreshStatus));
router.post(
  '/auto-refresh/resume',
  requireRole(['admin']),
  asyncHandler(systemController.resumeAutoRefresh)
);

module.exports = router;
