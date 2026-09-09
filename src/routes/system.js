/**
 * 系统运行状态与日志路由
 * @module routes/system
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireRole, requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const systemController = require('../controllers/systemController');

const router = express.Router();

router.get(
  '/logs',
  requireRole(['admin']),
  requirePermission(PERMISSIONS.SYSTEM_LOGS_READ),
  asyncHandler(systemController.listSystemLogs)
);
router.get(
  '/auto-refresh',
  requireRole(['admin']),
  requirePermission(PERMISSIONS.SYSTEM_REFRESH_READ),
  asyncHandler(systemController.getAutoRefreshStatus)
);
router.post(
  '/auto-refresh/resume',
  requireRole(['admin']),
  requirePermission(PERMISSIONS.SYSTEM_REFRESH_MANAGE),
  asyncHandler(systemController.resumeAutoRefresh)
);
router.get(
  '/proxy-provider',
  requireRole(['admin']),
  requirePermission(PERMISSIONS.SYSTEM_PROXY_READ),
  asyncHandler(systemController.getProxyProviderStatus)
);
router.post(
  '/proxy-provider',
  requireRole(['admin']),
  requirePermission(PERMISSIONS.SYSTEM_PROXY_MANAGE),
  asyncHandler(systemController.switchProxyProvider)
);

router.get(
  '/operation-logs',
  requireRole(['admin']),
  requirePermission(PERMISSIONS.SYSTEM_LOGS_READ),
  asyncHandler(require('../controllers/operationLogController').listOperationLogs)
);

module.exports = router;
