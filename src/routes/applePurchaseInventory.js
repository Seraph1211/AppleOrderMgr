const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const queryService = require('../services/applePurchaseInventoryQueryService');
const events = require('../services/applePurchaseInventoryEvents');

function createRouter(service = queryService, eventService = events) {
  const router = express.Router();
  router.use(requirePermission(PERMISSIONS.INVENTORY_READ));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get(
    '/observations',
    asyncHandler(async (req, res) => res.json(await service.listObservations(req.query)))
  );
  router.get(
    '/monitor-changes',
    asyncHandler(async (req, res) => res.json(await service.listMonitorChanges(req.query)))
  );
  router.get(
    '/status',
    asyncHandler(async (_req, res) => res.json(await service.status()))
  );
  router.get('/events', asyncHandler(eventService.subscribe));
  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
