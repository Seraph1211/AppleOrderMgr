const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireRole } = require('../middleware/authMiddleware');
const service = require('../services/applePurchaseSyncTerminalService');

function createRouter(terminalService = service) {
  const router = express.Router();
  router.use(requireRole(['admin']));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({
        success: true,
        data: await terminalService.listTerminals(),
        requestId: req.requestId,
      });
    })
  );
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const data = await terminalService.createTerminal(req.body, req.user, req.requestId);
      req.auditTarget = `ApplePurchase 同步终端；终端 ${data.terminalId}`;
      res.status(201).json({ success: true, data, requestId: req.requestId });
    })
  );
  router.patch(
    '/:terminalId',
    asyncHandler(async (req, res) => {
      const data = await terminalService.updateTerminal(
        req.params.terminalId,
        req.body,
        req.user,
        req.requestId
      );
      req.auditTarget = `ApplePurchase 同步终端；终端 ${data.terminalId}`;
      res.json({ success: true, data, requestId: req.requestId });
    })
  );
  router.post(
    '/:terminalId/rotate-token',
    asyncHandler(async (req, res) => {
      const data = await terminalService.rotateToken(
        req.params.terminalId,
        req.body,
        req.user,
        req.requestId
      );
      req.auditTarget = `ApplePurchase 同步终端；终端 ${data.terminalId}；Token 已轮换`;
      res.json({ success: true, data, requestId: req.requestId });
    })
  );
  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
