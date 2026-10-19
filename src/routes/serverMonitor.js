const logger = require('../utils/logger');
const express = require('express');
const { requirePermission, requireAnyPermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/monitorService');
const logs = require('../services/monitorLogService');
const downloadTicket = require('../services/monitorLogDownloadTicket');
const notifications = require('../services/monitorNotificationService');
const notificationQueries = require('../services/monitorNotificationQueries');
const router = express.Router();
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
function respond(work) {
  return asyncHandler(async (req, res) => {
    try {
      res.json({ success: true, data: await work(req, res) });
    } catch (error) {
      logger.debug('监控操作未完成', { errorCode: error.code || error.name });
      throw error;
    }
  });
}
function waitForDrain(res) {
  return new Promise(resolve => {
    if (res.destroyed || res.writableEnded) {
      resolve(false);
      return;
    }
    const finish = writable => {
      res.off('drain', drained);
      res.off('close', closed);
      res.off('error', closed);
      resolve(writable);
    };
    const drained = () => finish(true);
    const closed = () => finish(false);
    res.once('drain', drained);
    res.once('close', closed);
    res.once('error', closed);
    if (res.destroyed || res.writableEnded) closed();
  });
}
router.use('/logs', requirePermission(PERMISSIONS.MONITOR_LOGS_READ));
router.get(
  '/logs/states',
  respond(() => logs.states())
);
router.get(
  '/logs/accounts',
  respond(req => logs.accounts(req.query))
);
router.post(
  '/logs/export-ticket',
  respond(async (req, res) => {
    const prepared = await logs.prepareExport(req.body);
    res.cookie(downloadTicket.COOKIE_NAME, downloadTicket.issue(req.user, prepared.query), {
      ...downloadTicket.cookieOptions(),
    });
    return { expiresInSeconds: downloadTicket.EXPIRES_IN_SECONDS };
  })
);
router.get(
  '/logs/export',
  asyncHandler(async (req, res) => {
    if (
      req.authContext?.source === 'download-cookie' &&
      !downloadTicket.matches(req.authContext, req.query)
    ) {
      return res.status(403).json({
        success: false,
        error: { code: 'DOWNLOAD_SCOPE_MISMATCH', message: '下载凭证与日志范围不一致' },
      });
    }
    const prepared = await logs.prepareExport(req.query);
    if (req.authContext?.source === 'download-cookie') {
      const clearOptions = downloadTicket.cookieOptions();
      delete clearOptions.maxAge;
      res.clearCookie(downloadTicket.COOKIE_NAME, clearOptions);
    }
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${prepared.fileName}"`,
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
    await logs.writeExport(prepared, async chunk => {
      if (res.destroyed) return false;
      return res.write(chunk) || (await waitForDrain(res));
    });
    if (!res.destroyed) res.end();
  })
);
router.get(
  '/logs/:id/context',
  respond(req => logs.context(req.params.id, req.query))
);
router.get(
  '/logs',
  respond(req => logs.list(req.query))
);
const notificationRead = requireAnyPermission([
  PERMISSIONS.MONITOR_MANAGE,
  PERMISSIONS.MONITOR_NOTIFICATIONS_READ,
]);
const notificationConfigure = requireAnyPermission([
  PERMISSIONS.MONITOR_MANAGE,
  PERMISSIONS.MONITOR_NOTIFICATIONS_CONFIGURE,
]);
const notificationRetry = requireAnyPermission([
  PERMISSIONS.MONITOR_MANAGE,
  PERMISSIONS.MONITOR_NOTIFICATIONS_RETRY,
]);
router.get(
  '/notifications/channels',
  notificationRead,
  respond(() => notifications.channels())
);
router.put(
  '/notifications/channels/:channel',
  notificationConfigure,
  respond(req => notifications.saveChannel(req.user.id, req.params.channel, req.body))
);
router.post(
  '/notifications/channels/:channel/test',
  notificationConfigure,
  respond(req => notifications.queueTest(req.params.channel, req.body))
);
router.post(
  '/notifications/channels/:channel/current-summary',
  notificationConfigure,
  respond(req => notificationQueries.currentSummary(req.params.channel, req.body))
);
router.get(
  '/notifications/health',
  notificationRead,
  respond(() => notificationQueries.health())
);
router.get(
  '/notifications/deliveries',
  notificationRead,
  respond(req => notificationQueries.deliveries(req.query))
);
router.get(
  '/notifications/deliveries/:id',
  notificationRead,
  respond(req => notificationQueries.detail(req.params.id))
);
router.post(
  '/notifications/deliveries/:id/retry',
  notificationRetry,
  respond(req => notificationQueries.mutate(req.user.id, req.params.id, req.body))
);
router.post(
  '/notifications/deliveries/:id/cancel',
  notificationRetry,
  respond(req => notificationQueries.mutate(req.user.id, req.params.id, req.body, true))
);
router.use(requirePermission(PERMISSIONS.MONITOR_MANAGE));
router.get(
  '/overview',
  respond(() => service.overview())
);
router.get(
  '/traffic',
  respond(req => service.traffic(req.query))
);
router.get(
  '/instances/:id/history',
  respond(req => service.history(req.params.id, Number(req.query.page || 1)))
);
router.post(
  '/instances/:id/actions',
  respond(req => service.act(req.user.id, req.params.id, req.body))
);
router.post(
  '/rules/test',
  respond(req => service.testRule(req.body))
);
router.post(
  '/rules',
  respond(req => service.saveRule(req.user.id, null, req.body))
);
router.put(
  '/rules/:id',
  respond(req => service.saveRule(req.user.id, req.params.id, req.body))
);
router.put(
  '/notifications/settings',
  respond(req => notifications.saveSettings(req.user.id, req.body))
);
router.post(
  '/notifications/test',
  respond(() => notifications.queueTest())
);
router.get(
  '/notifications/history',
  respond(req => notificationQueries.history(Number(req.query.page || 1)))
);
module.exports = router;
