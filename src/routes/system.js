/**
 * 系统运行状态与日志路由
 * @module routes/system
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireRole, requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const retiredFeature = require('../middleware/retiredFeature');

const router = express.Router();

router.get('/logs', retiredFeature('爬虫运行日志'));
router.get('/auto-refresh', retiredFeature('官网自动刷新状态'));
router.post('/auto-refresh/resume', retiredFeature('官网自动刷新控制'));
router.get('/proxy-provider', retiredFeature('官网刷新代理切换'));
router.post('/proxy-provider', retiredFeature('官网刷新代理切换'));

router.get(
  '/operation-logs',
  requireRole(['admin']),
  requirePermission(PERMISSIONS.SYSTEM_LOGS_READ),
  asyncHandler(require('../controllers/operationLogController').listOperationLogs)
);

module.exports = router;
