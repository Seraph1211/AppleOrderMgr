const logger = require('../utils/logger');
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { Op } = require('sequelize');
const db = require('../models');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { only, dateOnly } = require('../utils/stockRules');
const command = require('../services/stockCommandService');
const units = require('../services/stockUnitService');
const sales = require('../services/stockSalesService');
const transfers = require('../services/stockTransferService');
const finance = require('../services/stockFinanceService');
const expenses = require('../services/stockExpenseService');
const projection = require('../services/stockProjectionService');
const corrections = require('../services/stockCorrectionService');
const evidence = require('../services/stockEvidenceService');
const imports = require('../controllers/stockImportController');
const ledger = require('../services/stockLedgerService');
const ledgerProjection = require('../services/stockLedgerProjectionService');
const router = express.Router();
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
// 旧复杂流程只保留查询；历史占用允许取消以免遗留锁定实机。
router.use((req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const legacyFlow =
    /^\/(sales|consignment-sales|expenses|transfers|collections|receipts|corrections|imports)(\/|$)/.test(
      req.path
    );
  const legacyUnit = /^\/units(\/|$)/.test(req.path);
  const legacyCancel = req.method === 'POST' && /^\/sales\/[^/]+\/cancel$/.test(req.path);
  if ((legacyFlow && !legacyCancel) || legacyUnit)
    return next(
      new ApiError(410, 'STOCK_FLOW_RETIRED', '原复杂库存流程已退役，请使用自有库存台账操作')
    );
  return next();
});
/** 读取使用同一可重复读快照。 */
function read(permissions, work) {
  return asyncHandler(async (req, res) => {
    try {
      const data = await db.sequelize.transaction(
        { isolationLevel: 'REPEATABLE READ' },
        async transaction => {
          const ctx = await command.createReadContext(req.user, transaction);
          command.requirePermissions(ctx, ...permissions);
          return work(ctx, req);
        }
      );
      res.json({ success: true, data });
    } catch (error) {
      logger.debug('库存处理未完成', { module: 'stock', code: error.code || error.name });
      throw error;
    }
  });
}
/** 成功命令的返回先重新鉴权，再按领域读取安全DTO。 */
async function materialize(user, refs) {
  try {
    return await db.sequelize.transaction(
      { isolationLevel: 'REPEATABLE READ' },
      async transaction => {
        const ctx = await command.createReadContext(user, transaction);
        let detail = {};
        if (refs.ledgerUnitIds)
          detail.items = await ledgerProjection.byIds(ctx, refs.ledgerUnitIds);
        else if (refs.saleId && ctx.permissions.has('stock.sales.read'))
          detail = await projection.saleDetail(ctx, refs.saleId);
        else if (refs.unitId) detail = await projection.unitDetail(ctx, refs.unitId);
        else if (refs.unitIds) detail.items = await projection.unitsByIds(ctx, refs.unitIds);
        else if (refs.receiptId) detail = await projection.receiptDetail(ctx, refs.receiptId);
        else if (refs.transferId) detail = await projection.transferDetail(ctx, refs.transferId);
        else if (refs.settingsId) {
          command.requirePermissions(ctx, 'stock.settings.manage');
          detail = (await db.StockSetting.findByPk(1, { transaction })).toJSON();
        } else if (refs.catalogType) {
          const mapping = {
            products: 'StockProduct',
            locations: 'StockLocation',
            parties: 'StockParty',
            prices: 'StockOfficialPrice',
          };
          detail = (await command.getRow(mapping[refs.catalogType], refs.id, ctx)).toJSON();
          delete detail.contactCiphertext;
          if (refs.catalogType === 'prices') command.requirePermissions(ctx, 'stock.cost.read');
        } else if (refs.targetId) {
          if (refs.kind.startsWith('unit'))
            detail = await projection.unitDetail(ctx, refs.targetId);
          else if (refs.kind === 'sale_fact')
            detail = await projection.saleDetail(ctx, refs.targetId);
          else if (refs.kind === 'receipt_fact')
            detail = await projection.receiptDetail(ctx, refs.targetId);
        }
        return { ...detail, ...refs };
      }
    );
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stock', code: error.code || error.name });
    throw error;
  }
}
function write(action, permissions, work, fields, { allowDisabled = false, created = false } = {}) {
  return asyncHandler(async (req, res) => {
    try {
      only(req.body, [...fields, 'requestKey', 'expectedVersion']);
      const input = { ...req.body, targetId: req.params.id || null };
      const refs = await command.runCommand(
        req.user,
        input,
        action,
        permissions,
        ctx => work(ctx, req),
        { allowDisabled }
      );
      const data = await materialize(req.user, refs);
      res.status(created && !refs.idempotent ? 201 : 200).json({ success: true, data });
    } catch (error) {
      logger.debug('库存处理未完成', { module: 'stock', code: error.code || error.name });
      throw error;
    }
  });
}
const readStock = ['stock.read'];
router.get(
  '/ledger/catalog',
  read(readStock, ctx => ledgerProjection.catalog(ctx))
);
router.get(
  '/ledger',
  read(readStock, (ctx, req) => ledgerProjection.list(ctx, req.query))
);
router.get(
  '/ledger/check-serials',
  read(readStock, async (ctx, req) => {
    try {
      const serials = JSON.parse(req.query.serials || '[]');
      if (
        !Array.isArray(serials) ||
        !serials.length ||
        serials.length > 100 ||
        serials.some(
          value => typeof value !== 'string' || !/^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(value)
        )
      )
        throw ApiError.badRequest('SN 清单无效');
      const rows = await require('../models').StockUnit.findAll({
        where: { serialNumber: serials, state: ['in_stock', 'sold', 'in_transit'] },
        attributes: ['id', 'serialNumber'],
        transaction: ctx.transaction,
        raw: true,
      });
      return { existing: rows };
    } catch (error) {
      logger.debug('库存重复预检查未完成', { code: error.code || error.name });
      if (error instanceof SyntaxError) throw ApiError.badRequest('SN 清单无效');
      throw error;
    }
  })
);
router.get(
  '/ledger/:id',
  read(readStock, (ctx, req) => ledgerProjection.detail(ctx, req.params.id))
);
router.post(
  '/ledger/receive',
  write(
    'ledger.receive',
    ['stock.receive'],
    (ctx, req) => ledger.receiveUnits(ctx, req.body),
    ['units'],
    { created: true }
  )
);
router.post(
  '/ledger/sell',
  write(
    'ledger.sell',
    ['stock.sales.edit', 'stock.sales.ship'],
    (ctx, req) => ledger.sellUnits(ctx, req.body),
    ['units', 'salespersonName', 'handlerName', 'soldOn', 'payment', 'notes'],
    { created: true }
  )
);
router.post(
  '/ledger/history',
  write(
    'ledger.history',
    ['stock.import', 'stock.sales.edit', 'stock.sales.ship'],
    (ctx, req) => ledger.importHistory(ctx, req.body),
    ['units', 'salespersonName', 'handlerName', 'soldOn', 'payment', 'notes'],
    { created: true }
  )
);
router.post(
  '/ledger/payment',
  write(
    'ledger.payment',
    ['stock.collections.edit'],
    (ctx, req) => ledger.setPayment(ctx, req.body),
    ['units', 'payment', 'reason']
  )
);
router.patch(
  '/ledger/:id',
  write(
    'ledger.edit',
    ['stock.receive'],
    (ctx, req) => ledger.editUnit(ctx, req.params.id, req.body),
    [
      'serialNumber',
      'productId',
      'product',
      'warehouseId',
      'receivedOn',
      'orderNumber',
      'officialCostAmount',
      'acquiredOn',
      'extraExpenseAmount',
      'notes',
      'sale',
      'reason',
    ]
  )
);
router.post(
  '/ledger/:id/recover',
  write(
    'ledger.recover',
    ['stock.correct', 'stock.sales.ship', 'stock.receive'],
    (ctx, req) => ledger.recoverUnit(ctx, req.params.id, req.body),
    ['warehouseId', 'receivedOn', 'confirmInWarehouse', 'reason']
  )
);
router.get(
  '/settings',
  read(['stock.settings.manage'], ctx => command.getRow('StockSetting', 1, ctx))
);
router.patch(
  '/settings',
  write(
    'settings',
    ['stock.settings.manage'],
    (ctx, req) => units.saveSettings(ctx, req.body),
    ['enabled', 'cutoverAt'],
    { allowDisabled: true }
  )
);
router.get(
  '/catalog',
  read(readStock, ctx => projection.catalog(ctx))
);
const fields = {
  products: ['modelKey', 'modelName', 'storageGb', 'colorKey', 'colorName', 'skuCode', 'isActive'],
  locations: ['name', 'kind', 'city', 'partyId', 'isActive'],
  parties: ['name', 'partyType', 'roles', 'userId', 'contact', 'isActive'],
  prices: [
    'productId',
    'validFrom',
    'validTo',
    'amount',
    'sourceLabel',
    'sourceVersion',
    'isActive',
  ],
};
for (const type of Object.keys(fields)) {
  const permissions = ['stock.catalog.manage', ...(type === 'prices' ? ['stock.cost.edit'] : [])];
  router.post(
    `/${type}`,
    write(
      `${type}.create`,
      permissions,
      (ctx, req) => units.saveCatalog(ctx, type, null, req.body),
      fields[type],
      { allowDisabled: true, created: true }
    )
  );
  router.patch(
    `/${type}/:id`,
    write(
      `${type}.edit`,
      permissions,
      (ctx, req) => units.saveCatalog(ctx, type, req.params.id, req.body),
      fields[type],
      { allowDisabled: true }
    )
  );
}
router.get(
  '/prices',
  read(['stock.cost.read'], async (ctx, req) => {
    try {
      const where = {};
      if (req.query.productId) where.productId = req.query.productId;
      if (req.query.acquiredOn) {
        dateOnly(req.query.acquiredOn);
        where.validFrom = { [Op.lte]: req.query.acquiredOn };
        where[Op.or] = [{ validTo: null }, { validTo: { [Op.gt]: req.query.acquiredOn } }];
        where.isActive = true;
      }
      return {
        items: await db.StockOfficialPrice.findAll({
          where,
          transaction: ctx.transaction,
          order: [['validFrom', 'DESC']],
        }),
      };
    } catch (error) {
      logger.debug('库存处理未完成', { module: 'stock', code: error.code || error.name });
      throw error;
    }
  })
);
router.get(
  '/summary',
  read(readStock, (ctx, req) => projection.summary(ctx, req.query))
);
router.get(
  '/units',
  read(readStock, (ctx, req) => projection.listUnits(ctx, req.query))
);
router.post(
  '/units/receive',
  write(
    'units.receive',
    ['stock.receive'],
    (ctx, req) => units.receiveUnits(ctx, req.body),
    ['mode', 'units'],
    { created: true }
  )
);
router.post(
  '/units/register',
  write(
    'units.register',
    ['stock.receive'],
    (ctx, req) => units.receiveUnits(ctx, req.body, true),
    ['units'],
    { created: true }
  )
);
router.get(
  '/units/:id',
  read(readStock, (ctx, req) => projection.unitDetail(ctx, req.params.id))
);
router.put(
  '/units/:id/source-order',
  write(
    'unit.source',
    ['stock.source.link'],
    (ctx, req) => units.setSource(ctx, req.params.id, req.body),
    ['orderId', 'bindingId']
  )
);
router.put(
  '/units/:id/cost',
  write(
    'unit.cost',
    ['stock.cost.edit'],
    (ctx, req) => units.setCost(ctx, req.params.id, req.body),
    ['acquiredOn', 'status', 'amount', 'priceId', 'source', 'basis', 'reason']
  )
);
router.get(
  '/units/:id/events',
  read(readStock, (ctx, req) => projection.listEvents(ctx, 'StockUnit', req.params.id, req.query))
);
router.get(
  '/sales',
  read(['stock.sales.read'], (ctx, req) => projection.listSales(ctx, req.query))
);
router.post(
  '/sales',
  write(
    'sales.create',
    ['stock.sales.edit'],
    (ctx, req) => sales.saveSale(ctx, null, req.body),
    ['channel', 'customerId', 'salespersonId', 'lines', 'notes'],
    { created: true }
  )
);
router.get(
  '/sales/:id',
  read(['stock.sales.read'], (ctx, req) => projection.saleDetail(ctx, req.params.id))
);
router.patch(
  '/sales/:id',
  write(
    'sales.edit',
    ['stock.sales.edit'],
    (ctx, req) => sales.saveSale(ctx, req.params.id, req.body),
    ['customerId', 'salespersonId', 'lines', 'notes']
  )
);
router.post(
  '/sales/:id/reserve',
  write(
    'sales.reserve',
    ['stock.sales.edit'],
    (ctx, req) => sales.reserveSale(ctx, req.params.id, req.body),
    []
  )
);
router.put(
  '/sales/:id/picks',
  write(
    'sales.picks',
    ['stock.sales.ship'],
    (ctx, req) => sales.pickUnits(ctx, req.params.id, req.body),
    ['units']
  )
);
router.post(
  '/sales/:id/ship',
  write(
    'sales.ship',
    ['stock.sales.ship'],
    (ctx, req) => sales.shipSale(ctx, req.params.id, req.body),
    ['shippedAt', 'handlerId', 'unitPrices', 'collection']
  )
);
router.post(
  '/sales/:id/cancel',
  write(
    'sales.cancel',
    ['stock.sales.edit'],
    (ctx, req) => sales.cancelSale(ctx, req.params.id, req.body),
    ['reason']
  )
);
router.post(
  '/consignment-sales',
  write(
    'sales.consignment',
    ['stock.sales.ship'],
    (ctx, req) => sales.consignmentSale(ctx, req.body),
    ['locationId', 'salespersonId', 'handlerId', 'customerId', 'shippedAt', 'units', 'notes'],
    { created: true }
  )
);
router.put(
  '/sales/:id/fees-complete',
  write(
    'sales.fees',
    ['stock.expenses.edit'],
    (ctx, req) => expenses.feesComplete(ctx, req.params.id, req.body),
    ['complete']
  )
);
router.get(
  '/sales/:id/events',
  read(['stock.sales.read'], (ctx, req) =>
    projection.listEvents(ctx, 'StockSale', req.params.id, req.query)
  )
);
router.get(
  '/sales/:id/expenses',
  read(['stock.expenses.read'], async (ctx, req) => {
    try {
      return { items: (await projection.saleDetail(ctx, req.params.id)).expenses };
    } catch (error) {
      logger.debug('库存处理未完成', { module: 'stock', code: error.code || error.name });
      throw error;
    }
  })
);
const expenseFields = [
  'category',
  'scope',
  'amount',
  'occurredAt',
  'paidByPartyId',
  'saleUnitIds',
  'notes',
];
router.post(
  '/sales/:id/expenses',
  write(
    'expense.create',
    ['stock.expenses.edit'],
    (ctx, req) => expenses.saveExpense(ctx, req.params.id, null, req.body),
    expenseFields,
    { created: true }
  )
);
router.patch(
  '/expenses/:id',
  write(
    'expense.edit',
    ['stock.expenses.edit', 'stock.correct'],
    (ctx, req) => expenses.saveExpense(ctx, null, req.params.id, req.body),
    [...expenseFields, 'reason']
  )
);
router.post(
  '/expenses/:id/void',
  write(
    'expense.void',
    ['stock.expenses.edit', 'stock.correct'],
    (ctx, req) => expenses.voidExpense(ctx, req.params.id, req.body),
    ['reason']
  )
);
router.get(
  '/transfers',
  read(readStock, (ctx, req) => projection.listTransfers(ctx, req.query))
);
router.post(
  '/transfers',
  write(
    'transfer.create',
    ['stock.transfer'],
    (ctx, req) => transfers.createTransfer(ctx, req.body),
    ['fromLocationId', 'originLabel', 'toLocationId', 'handlerId', 'unitIds', 'notes'],
    { created: true }
  )
);
router.get(
  '/transfers/:id',
  read(readStock, (ctx, req) => projection.transferDetail(ctx, req.params.id))
);
router.post(
  '/transfers/:id/dispatch',
  write(
    'transfer.dispatch',
    ['stock.transfer'],
    (ctx, req) => transfers.dispatchTransfer(ctx, req.params.id, req.body),
    ['dispatchedAt']
  )
);
router.post(
  '/transfers/:id/receive',
  write(
    'transfer.receive',
    ['stock.transfer'],
    (ctx, req) => transfers.receiveTransfer(ctx, req.params.id, req.body),
    ['receivedAt', 'unitIds']
  )
);
router.post(
  '/transfers/:id/cancel',
  write(
    'transfer.cancel',
    ['stock.transfer'],
    (ctx, req) => transfers.cancelTransfer(ctx, req.params.id, req.body),
    ['reason']
  )
);
router.get(
  '/collections',
  read(['stock.collections.read'], (ctx, req) => projection.listCollections(ctx, req.query))
);
router.get(
  '/collections/:id',
  read(['stock.collections.read'], (ctx, req) => projection.collectionDetail(ctx, req.params.id))
);
router.get(
  '/expenses/:id',
  read(['stock.expenses.read'], (ctx, req) => projection.expenseDetail(ctx, req.params.id))
);
router.post(
  '/collections',
  write(
    'collection.create',
    ['stock.collections.edit'],
    (ctx, req) => finance.createCollection(ctx, req.body),
    ['saleId', 'destination', 'collectorId', 'amount', 'receivedAt', 'notes'],
    { created: true }
  )
);
router.get(
  '/receipts',
  read(['stock.receipts.read'], (ctx, req) => projection.listReceipts(ctx, req.query))
);
router.get(
  '/receipts/:id',
  read(['stock.receipts.read'], (ctx, req) => projection.receiptDetail(ctx, req.params.id))
);
router.post(
  '/receipts',
  write(
    'receipt.create',
    ['stock.receipts.edit'],
    (ctx, req) => finance.createReceipt(ctx, req.body),
    ['source', 'payerId', 'receivedAt', 'amount', 'allocations', 'notes'],
    { created: true }
  )
);
router.put(
  '/receipts/:id/allocations',
  write(
    'receipt.allocations',
    ['stock.receipts.edit'],
    (ctx, req) => finance.setAllocations(ctx, req.params.id, req.body),
    ['allocations']
  )
);
router.get(
  '/receivable-summary',
  read(['stock.receipts.read'], (ctx, req) => projection.receivableSummary(ctx, req.query))
);
router.get(
  '/reports/sales',
  read(['stock.sales.read'], (ctx, req) => projection.reports(ctx, 'sales', req.query))
);
router.get(
  '/reports/receipts',
  read(['stock.receipts.read'], (ctx, req) => projection.reports(ctx, 'receipts', req.query))
);
router.post(
  '/corrections/preview',
  asyncHandler(async (req, res) => {
    try {
      only(req.body, ['requestKey', 'kind', 'targetId', 'expectedVersion', 'changes', 'reason']);
      res.json({ success: true, data: await corrections.previewCorrection(req.user, req.body) });
    } catch (error) {
      logger.debug('库存处理未完成', { module: 'stock', code: error.code || error.name });
      throw error;
    }
  })
);
router.post(
  '/corrections',
  asyncHandler(async (req, res) => {
    try {
      only(req.body, [
        'requestKey',
        'kind',
        'targetId',
        'expectedVersion',
        'changes',
        'reason',
        'previewToken',
      ]);
      const refs = await command.runCommand(
        req.user,
        req.body,
        'correction',
        [
          'stock.correct',
          {
            ['unit_identity']: 'stock.receive',
            ['unit_location']: 'stock.transfer',
            ['sale_fact']: 'stock.sales.ship',
            ['collection_fact']: 'stock.collections.edit',
            ['receipt_fact']: 'stock.receipts.edit',
          }[req.body.kind] || 'stock.settings.manage',
        ],
        ctx => corrections.applyCorrection(ctx, req.body)
      );
      res.json({ success: true, data: await materialize(req.user, refs) });
    } catch (error) {
      logger.debug('库存处理未完成', { module: 'stock', code: error.code || error.name });
      throw error;
    }
  })
);
router.post(
  '/attachments/prepare',
  asyncHandler(async (req, res) => {
    try {
      const refs = await command.runCommand(
        req.user,
        req.body,
        'attachment.prepare',
        ['stock.read'],
        ctx => evidence.prepareAttachment(ctx, req.body)
      );
      res.status(201).json({
        success: true,
        data: { ...(await evidence.readUpload(req.user, refs.attachmentId)), ...refs },
      });
    } catch (error) {
      logger.debug('库存处理未完成', { module: 'stock', code: error.code || error.name });
      throw error;
    }
  })
);
router.post(
  '/attachments/:id/confirm',
  asyncHandler(async (req, res) => {
    try {
      const verified = await evidence.verifyAttachment(req.user, req.params.id);
      const refs = await command.runCommand(
        req.user,
        { ...req.body, targetId: req.params.id },
        'attachment.confirm',
        ['stock.read'],
        ctx => evidence.confirmAttachment(ctx, req.params.id, req.body, verified)
      );
      res.json({
        success: true,
        data: { ...(await evidence.readAttachment(req.user, refs.attachmentId)), ...refs },
      });
    } catch (error) {
      logger.debug('库存处理未完成', { module: 'stock', code: error.code || error.name });
      throw error;
    }
  })
);
router.get(
  '/attachments/:id/read',
  asyncHandler(async (req, res) => {
    try {
      res.json({ success: true, data: await evidence.readAttachment(req.user, req.params.id) });
    } catch (error) {
      logger.debug('库存处理未完成', { module: 'stock', code: error.code || error.name });
      throw error;
    }
  })
);
function upload(field, fieldsCount) {
  const middleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: fieldsCount, parts: fieldsCount + 2 },
  }).single(field);
  return (req, res, next) =>
    middleware(req, res, error =>
      next(error ? ApiError.badRequest('文件无效或超过10MiB') : undefined)
    );
}
const stockOcrLimit = rateLimit({
  windowMs: 60000,
  limit: 10,
  keyGenerator: req => String(req.user.id),
  handler: (_req, _res, next) => next(new ApiError(429, 'OCR_RATE_LIMIT', '识别过于频繁')),
});
router.post(
  '/box/recognize',
  stockOcrLimit,
  upload('image', 1),
  asyncHandler(async (req, res) => {
    try {
      const data = await require('../services/stockBoxService').recognizeBox(
        req.user,
        req.file,
        req.body.barcodes
      );
      res.set('Cache-Control', 'no-store').json({ success: true, data });
    } catch (error) {
      logger.debug('库存盒标识别未完成', { code: error.code || error.name });
      throw error;
    }
  })
);
router.post(
  '/serial/recognize',
  stockOcrLimit,
  upload('image', 0),
  asyncHandler(async (req, res) => {
    try {
      res.json({ success: true, data: await evidence.recognizeSerial(req.user, req.file) });
    } catch (error) {
      logger.debug('库存处理未完成', { module: 'stock', code: error.code || error.name });
      throw error;
    }
  })
);
router.get('/imports/template', asyncHandler(imports.template));
router.post('/imports/preview', upload('file', 3), asyncHandler(imports.preview));
router.post('/imports/:id/commit', asyncHandler(imports.commit));
router.get('/imports/:id', asyncHandler(imports.get));
router.get('/export', asyncHandler(imports.exportFile));
// 不把数据库驱动详情或请求原文暴露给客户端。
router.use((error, _req, res, _next) => {
  if (error instanceof ApiError)
    return res.status(error.statusCode).json({ success: false, error: error.toJSON() });
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: '库存处理失败，请重试或联系管理员' },
  });
});
module.exports = router;
