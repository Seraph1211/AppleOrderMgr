const crypto = require('crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const inventory = require('../services/applePurchaseInventoryQueryService');
const events = require('../services/applePurchaseInventoryEvents');

const HISTORY_PAGE_SIZE = 20;
const REFERENCE_LENGTH = 12;
const CHANGE_FIELDS = [
  ['storeIds', 'stores'],
  ['partNumbers', 'products'],
  ['taskDemands', 'tasks'],
];
const PUBLIC_CONTROL_STATES = new Set(['running', 'stopped', 'paused']);

function reference(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, REFERENCE_LENGTH);
}

function publicTerminal(id) {
  return `终端 ${reference(id)}`;
}

function summarizeChanges(before, after) {
  const changes = [];
  for (const [key, kind] of CHANGE_FIELDS) {
    const values = snapshot => {
      const value = snapshot?.[key];
      if (Array.isArray(value)) {
        return new Set(value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))));
      }
      if (kind === 'tasks' && value && typeof value === 'object') {
        return new Set(Object.entries(value).map(entry => JSON.stringify(entry)));
      }
      return new Set();
    };
    const previous = values(before);
    const current = values(after);
    const added = [...current].filter(value => !previous.has(value)).length;
    const removed = [...previous].filter(value => !current.has(value)).length;
    if (added || removed) {
      changes.push({ kind, before: previous.size, after: current.size, added, removed });
    }
  }
  const stateBefore = before?.controlState;
  const stateAfter = after?.controlState;
  if (stateBefore !== stateAfter && PUBLIC_CONTROL_STATES.has(stateAfter)) {
    changes.push({
      kind: 'state',
      before: PUBLIC_CONTROL_STATES.has(stateBefore) ? stateBefore : null,
      after: stateAfter,
    });
  }
  return changes;
}

function configurationSnapshot(after) {
  if (!after) return null;
  const stores = Array.isArray(after.stores) ? after.stores : [];
  const products = Array.isArray(after.products) ? after.products : [];
  const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
  return {
    state: PUBLIC_CONTROL_STATES.has(after.controlState) ? after.controlState : null,
    stores: stores
      .map(item => ({
        city: text(item?.city, 128),
        name: text(item?.name, 256),
      }))
      .filter(item => item.name),
    products: products
      .map(item => ({
        name: text(item?.name, 256),
        specification: text(item?.specification, 512),
      }))
      .filter(item => item.name || item.specification),
  };
}

/** 创建无需登录的只读展示接口，投影公开字段并限制查询频率。 @returns {Object} 路由 */
function createRouter(service = inventory, eventService = events) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 60,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: { code: 'RATE_LIMITED', message: '访问过于频繁，请稍后再试' },
      },
    })
  );
  router.get(
    '/options',
    asyncHandler(async (_req, res) => {
      const options = await service.availabilityOptions();
      res.json({
        snapshot: options.snapshot,
        firstDetectedAt: options.firstDetectedAt,
        lastDetectedAt: options.lastDetectedAt,
        lastSyncAt: options.lastSyncAt,
        cities: options.cities,
        families: options.families,
        colors: options.colors,
        capacities: options.capacities,
        stores: options.stores.map(({ id, city, name }) => ({ id, city, name })),
        terminals: options.terminals.map(({ id }) => ({ id, name: publicTerminal(id) })),
      });
    })
  );
  router.get(
    '/records',
    asyncHandler(async (req, res) => {
      const page = await service.availabilityRecords(req.query);
      res.json({
        total: page.total,
        nextCursor: page.nextCursor,
        items: page.items.map(row => ({
          sequence: row.sequence,
          id: reference(`${row.terminalId}:${row.id}`),
          detectedAt: row.detectedAt,
          ingestedAt: row.ingestedAt,
          terminalId: row.terminalId,
          city: row.city,
          storeId: row.storeId,
          store: row.store,
          family: row.family,
          color: row.color,
          storage: row.storage,
          productName: row.productName,
          partNumber: row.partNumber,
        })),
      });
    })
  );
  router.get(
    '/trend',
    asyncHandler(async (req, res) => {
      res.json(await service.availabilityTrend(req.query));
    })
  );
  router.get(
    '/changes',
    asyncHandler(async (req, res) => {
      const { cursor } = req.query;
      const result = await service.listMonitorChanges({
        ...(cursor === undefined ? {} : { cursor }),
        limit: HISTORY_PAGE_SIZE,
        direction: 'desc',
      });
      res.json({
        snapshot: result.page.highWaterSequence,
        nextCursor: result.page.nextCursor,
        items: result.items.map(row => ({
          sequence: row.sequence,
          changedAt: row.changedAt,
          changeType: row.changeType,
          previousRevision: row.previousRevision,
          revision: row.revision,
          terminal: publicTerminal(row.terminalId),
          changes: summarizeChanges(row.before, row.after),
          configuration: configurationSnapshot(row.after),
        })),
      });
    })
  );
  router.get('/events', asyncHandler(eventService.subscribe));
  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
