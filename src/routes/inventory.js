const inventoryFailure = require('../utils/inventoryFailure');
const express = require('express');
const { requireRole } = require('../middleware/authMiddleware');
const asyncHandler = require('../utils/asyncHandler');
const InventoryService = require('../services/inventoryService');
const InventoryAnalysis = require('../services/inventoryAnalysis');
const InventoryNotifier = require('../services/inventoryNotifier');
const InventoryMaintenance = require('../services/inventoryMaintenance');
const InventoryValidationGate = require('../services/inventoryValidationGate');

/** 创建库存 API，可注入隔离数据库用于真实路由回归。 @param {Object} service 服务 @returns {Object} 路由 */
function createRouter(service = new InventoryService()) {
  const router = express.Router();
  const analysis = new InventoryAnalysis(service);
  const notifier = new InventoryNotifier(service);
  const maintenance = new InventoryMaintenance(
    service,
    null,
    new InventoryValidationGate(service.db, { production: true })
  );
  router.use(requireRole(['admin']));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const handle = work =>
    asyncHandler(async (req, res) => {
      try {
        res.json({ success: true, data: await work(req) });
      } catch (error) {
        throw inventoryFailure(error);
      }
    });
  router.get(
    '/catalog',
    handle(() => service.catalog())
  );
  router.put(
    '/catalog',
    handle(req => service.setCatalog(req.body, req.user.id))
  );
  router.post(
    '/catalog/refresh',
    handle(() => service.refreshCatalog())
  );
  router.get(
    '/settings',
    handle(() => service.getSettings())
  );
  router.put(
    '/settings',
    handle(req => service.saveSettings(req.body, req.user.id))
  );
  router.get(
    '/latest',
    handle(req => service.latest(req.query))
  );
  router.post(
    '/refresh',
    handle(req => service.refresh(req.body, req.user.id))
  );
  router.get(
    '/rounds',
    handle(req => service.list('InventoryRound', req.query))
  );
  router.get(
    '/rounds/:id',
    handle(req => service.roundDetail(req.params.id, req.query))
  );
  router.get(
    '/history',
    handle(req => service.history(req.query))
  );
  router.get(
    '/history/export',
    asyncHandler(async (req, res) => {
      try {
        const { items } = await service.history(req.query, true);
        const cell = value =>
          `"${String(value ?? '')
            .replace(/^[=+\-@\t\r]/, "'$&")
            .replace(/"/g, '""')}"`;
        const columns = [
          ['sku', 'SKU'],
          ['city', '城市'],
          ['storeName', '门店'],
          ['model', '型号'],
          ['capacity', '容量'],
          ['color', '颜色'],
          ['status', '库存状态'],
          ['kind', '事件'],
          ['source', '来源'],
          ['observedAt', '发现时间（北京时间）'],
          ['quote', '官网提示'],
        ];
        const csv = [
          columns.map(([, label]) => cell(label)).join(','),
          ...items.map(row =>
            columns
              .map(([key]) =>
                cell(
                  key === 'observedAt'
                    ? new Date(row[key]).toLocaleString('zh-CN', {
                      timeZone: 'Asia/Shanghai',
                      hour12: false,
                    })
                    : row[key]
                )
              )
              .join(',')
          ),
        ].join('\r\n');
        res.set(
          'Content-Disposition',
          "attachment; filename=inventory-history.csv; filename*=UTF-8''%E5%BA%93%E5%AD%98%E5%8E%86%E5%8F%B2.csv"
        );
        res.type('text/csv; charset=utf-8').send(`\uFEFF${csv}`);
      } catch (error) {
        throw inventoryFailure(error);
      }
    })
  );
  router.get(
    '/analysis',
    handle(req => analysis.get(req.query))
  );
  router.get(
    '/health',
    handle(() => service.health())
  );
  router.post(
    '/resume',
    handle(req => maintenance.resume(req.user.id))
  );
  router.post(
    '/notifications/test',
    handle(req => notifier.test(req.user.id))
  );
  router.get(
    '/deliveries',
    handle(req => service.list('InventoryDelivery', req.query))
  );
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
