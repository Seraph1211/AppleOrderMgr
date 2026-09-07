/**
 * 系统运行状态与日志路由
 * @module routes/system
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireRole } = require('../middleware/authMiddleware');
const systemController = require('../controllers/systemController');

const router = express.Router();

router.get('/logs', requireRole(['admin']), asyncHandler(systemController.listSystemLogs));
router.get(
  '/auto-refresh',
  requireRole(['admin']),
  asyncHandler(systemController.getAutoRefreshStatus)
);
router.post(
  '/auto-refresh/resume',
  requireRole(['admin']),
  asyncHandler(systemController.resumeAutoRefresh)
);
router.get(
  '/proxy-provider',
  requireRole(['admin']),
  asyncHandler(systemController.getProxyProviderStatus)
);
router.post(
  '/proxy-provider',
  requireRole(['admin']),
  asyncHandler(systemController.switchProxyProvider)
);

module.exports = router;
