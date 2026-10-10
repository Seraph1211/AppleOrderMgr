const logger = require('../utils/logger');
const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { decrypt, decryptJson } = require('../utils/fieldEncryption');
const { cents, money } = require('../utils/stockMoney');
const { array, instant, choice, uuid } = require('../utils/stockRules');
const { scopeOrderWhere } = require('./orderAccessService');
const { requirePermissions, getRow } = require('./stockCommandService');
/** 读取一组业务快照，以批量查询替代每行额外请求。 */
async function graph(ctx, scope = null) {
  try {
    const names = [
      'StockProduct',
      'StockLocation',
      'StockParty',
      'StockUnit',
      'StockSale',
      'StockSaleLine',
      'StockSaleUnit',
      'StockExpense',
      'StockExpenseAllocation',
      'StockCollection',
      'StockReceipt',
      'StockReceiptAllocation',
      'StockTransfer',
      'StockTransferUnit',
      'PickupDevice',
    ];
    const result = Object.fromEntries(names.map(name => [name, []]));
    const load = (name, where) =>
      db[name].findAll({ ...(where ? { where } : {}), transaction: ctx.transaction, raw: true });
    if (!scope) {
      for (const name of names) result[name] = await load(name);
    } else {
      const unitIds = new Set(scope.unitIds || []);
      const saleIds = new Set(scope.saleIds || []);
      const receiptIds = new Set(scope.receiptIds || []);
      const collectionIds = new Set(scope.collectionIds || []);
      if (scope.transferIds?.length) {
        result.StockTransfer = await load('StockTransfer', { id: scope.transferIds });
        result.StockTransferUnit = await load('StockTransferUnit', {
          transferId: scope.transferIds,
        });
        result.StockTransferUnit.forEach(row => unitIds.add(row.stockUnitId));
      }
      if (receiptIds.size) {
        const receipt = await load('StockReceipt', { id: [...receiptIds] });
        result.StockReceipt = receipt;
        receipt.forEach(row => {
          if (row.collectionId) collectionIds.add(row.collectionId);
        });
        const alloc = await load('StockReceiptAllocation', { receiptId: [...receiptIds] });
        alloc.forEach(row => collectionIds.add(row.collectionId));
      }
      if (collectionIds.size) {
        const collections = await load('StockCollection', { id: [...collectionIds] });
        collections.forEach(row => saleIds.add(row.saleId));
      }
      if (unitIds.size) {
        const items = await load('StockSaleUnit', {
          stockUnitId: [...unitIds],
          status: { [Op.in]: ['picked', 'shipped'] },
        });
        if (items.length) {
          const lines = await load('StockSaleLine', { id: items.map(i => i.saleLineId) });
          lines.forEach(row => saleIds.add(row.saleId));
        }
      }
      if (saleIds.size) {
        result.StockSale = await load('StockSale', { id: [...saleIds] });
        result.StockSaleLine = await load('StockSaleLine', { saleId: [...saleIds] });
        result.StockSaleUnit = await load('StockSaleUnit', {
          saleLineId: result.StockSaleLine.map(row => row.id),
        });
        result.StockSaleUnit.forEach(row => unitIds.add(row.stockUnitId));
        if (ctx.permissions.has('stock.expenses.read')) {
          result.StockExpense = await load('StockExpense', { saleId: [...saleIds] });
          result.StockExpenseAllocation = await load('StockExpenseAllocation', {
            expenseId: result.StockExpense.map(row => row.id),
          });
        }
        if (ctx.permissions.has('stock.collections.read')) {
          result.StockCollection = await load('StockCollection', { saleId: [...saleIds] });
          result.StockCollection.forEach(row => collectionIds.add(row.id));
        }
      }
      if (ctx.permissions.has('stock.receipts.read')) {
        result.StockReceiptAllocation = await load('StockReceiptAllocation', {
          [Op.or]: [{ collectionId: [...collectionIds] }, { receiptId: [...receiptIds] }],
        });
        result.StockReceiptAllocation.forEach(row => receiptIds.add(row.receiptId));
        result.StockReceipt = await load('StockReceipt', {
          [Op.or]: [{ id: [...receiptIds] }, { collectionId: [...collectionIds] }],
        });
      }
      result.StockUnit = await load('StockUnit', { id: [...unitIds] });
      result.PickupDevice = await load('PickupDevice', { stockUnitId: [...unitIds] });
      const products = new Set(
        [
          ...result.StockUnit.map(u => u.productId),
          ...result.StockSaleLine.map(l => l.productId),
        ].filter(Boolean)
      );
      result.StockProduct = await load('StockProduct', { id: [...products] });
      const locations = new Set(
        [
          ...result.StockUnit.flatMap(u => [u.locationId, u.returnLocationId]),
          ...result.StockSaleUnit.map(u => u.fromLocationId),
          ...result.StockTransfer.flatMap(t => [t.fromLocationId, t.toLocationId]),
        ].filter(Boolean)
      );
      result.StockLocation = await load('StockLocation', { id: [...locations] });
      const parties = new Set(
        [
          ...result.StockSale.flatMap(r => [
            r.customerId,
            r.salespersonId,
            r.handlerId,
            r.pendingCollectorId,
          ]),
          ...result.StockCollection.map(r => r.collectorId),
          ...result.StockReceipt.map(r => r.payerId),
          ...result.StockTransfer.map(r => r.handlerId),
        ].filter(Boolean)
      );
      result.StockParty = await load('StockParty', { id: [...parties] });
    }
    const bindings = result.PickupDevice;
    result.Order = [];
    if (ctx.permissions.has('orders.read') && bindings.length) {
      result.Order = await db.Order.findAll({
        where: scopeOrderWhere(ctx.user, { id: { [Op.in]: bindings.map(b => b.orderId) } }),
        attributes: ['id', 'orderNumber'],
        transaction: ctx.transaction,
        raw: true,
      });
    }
    return result;
  } catch (error) {
    logger.debug('库存快照读取失败', { code: error.code || error.name });
    throw error;
  }
}
/** 批量收货响应共享一份关联快照，不逐台重复加载全表。 */
async function unitsByIds(ctx, ids) {
  try {
    requirePermissions(ctx, 'stock.read');
    const g = await graph(ctx, { unitIds: ids });
    return ids.map(id => projectUnit(ctx, byId(g.StockUnit, id), g));
  } catch (error) {
    logger.debug('库存批量读取失败', { code: error.code || error.name });
    throw error;
  }
}
function paging(query) {
  const pageNumber = Number(query.page || 1);
  const size = Number(query.pageSize || 20);
  if (
    !Number.isInteger(pageNumber) ||
    pageNumber < 1 ||
    (![20, 50, 100].includes(size) && !(query.internalExport === true && size === 5000))
  )
    throw ApiError.badRequest('分页参数无效');
  return { page: pageNumber, pageSize: size, limit: size, offset: (pageNumber - 1) * size };
}
function dateWhere(query, field, where) {
  const from = query.from ? instant(query.from) : null;
  const to = query.to ? instant(query.to) : null;
  if (from && to && +from >= +to) throw ApiError.badRequest('日期区间无效');
  if (from || to)
    where[field] = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lt]: to } : {}) };
}
async function databasePage(ctx, model, where, query) {
  try {
    const options = paging(query);
    const { rows, count } = await db[model].findAndCountAll({
      where,
      limit: options.limit,
      offset: options.offset,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      transaction: ctx.transaction,
      raw: true,
    });
    return { rows, total: count, page: options.page, pageSize: options.pageSize };
  } catch (error) {
    logger.debug('库存分页失败', { code: error.code || error.name });
    throw error;
  }
}

function base(row) {
  const copy = { ...row };
  for (const key of Object.keys(copy)) if (key.endsWith('Ciphertext')) delete copy[key];
  return copy;
}
function byId(rows, id) {
  return rows.find(row => row.id === id) || null;
}
function allowed(ctx, pairs) {
  return pairs
    .filter(([, permission]) => ctx.permissions.has(permission))
    .map(([action]) => action);
}
function party(ctx, row) {
  if (!row) return null;
  const result = base(row);
  if (ctx.permissions.has('stock.catalog.manage')) result.contact = decrypt(row.contactCiphertext);
  return result;
}
function source(ctx, unit, g) {
  const binding = g.PickupDevice.find(
    row => row.stockUnitId === unit.id || row.serialNumber === unit.serialNumber
  );
  if (!binding) return { linked: false };
  const order = byId(g.Order, binding.orderId);
  if (!order) return { linked: true };
  return {
    linked: true,
    id: order.id,
    number: order.orderNumber,
    bindingId: binding.id,
    canOpen: true,
  };
}
/** 单台字段权限投影用于详情、列表和导出。 */
function projectUnit(ctx, unit, g) {
  const result = base(unit);
  delete result.orderNumberText;
  if (!ctx.permissions.has('stock.expenses.read')) delete result.extraExpenseAmount;
  if (!ctx.permissions.has('stock.cost.read')) {
    for (const key of ['acquiredOn', 'costStatus', 'officialCostAmount', 'priceId', 'costSource'])
      delete result[key];
  } else result.costBasis = decrypt(unit.costBasisCiphertext);
  Object.assign(result, {
    product: byId(g.StockProduct, unit.productId),
    location: byId(g.StockLocation, unit.locationId),
    sourceOrder: source(ctx, unit, g),
    allowedActions: allowed(ctx, [
      ['receive', 'stock.receive'],
      ['source', 'stock.source.link'],
      ['cost', 'stock.cost.edit'],
      ['correct', 'stock.correct'],
      ['transfer', 'stock.transfer'],
    ]),
  });
  const saleUnit = g.StockSaleUnit.find(
    row => row.stockUnitId === unit.id && ['picked', 'shipped'].includes(row.status)
  );
  if (saleUnit && ctx.permissions.has('stock.sales.read')) {
    const line = byId(g.StockSaleLine, saleUnit.saleLineId);
    const sale = byId(g.StockSale, line?.saleId);
    result.sale = {
      id: sale.id,
      saleNo: sale.saleNo,
      status: sale.status,
      saleUnitId: saleUnit.id,
      saleAmount: saleUnit.saleAmount,
      settlementAmount: saleUnit.settlementAmount,
    };
  }
  return result;
}
function expensesFor(ctx, saleId, g) {
  return g.StockExpense.filter(row => row.saleId === saleId).map(row => ({
    ...base(row),
    notes: decrypt(row.notesCiphertext),
    allocations: g.StockExpenseAllocation.filter(
      a => a.expenseId === row.id && a.expenseVersion === row.version
    ),
  }));
}
/** 销售明细仅附带授权金额，未知成本不当作0利润。 */
function projectSale(ctx, sale, g) {
  const result = { ...base(sale), notes: decrypt(sale.notesCiphertext) };
  delete result.paymentVerification;
  delete result.pendingCollectorId;
  delete result.pendingCollectedAt;
  const lines = g.StockSaleLine.filter(line => line.saleId === sale.id);
  const entries = g.StockSaleUnit.filter(
    row =>
      lines.some(line => line.id === row.saleLineId) && ['picked', 'shipped'].includes(row.status)
  );
  const expenses = expensesFor(ctx, sale.id, g);
  const activeExpenses = expenses.filter(e => e.status === 'active');
  let total = 0n;
  let knownCost = 0n;
  let unknownCount = 0;
  let unknownProfitCount = 0;
  let knownProfit = 0n;
  const units = entries.map(entry => {
    const unit = byId(g.StockUnit, entry.stockUnitId);
    const income = sale.simpleLedger ? entry.settlementAmount : entry.saleAmount;
    if (income == null || entry.costAmountSnapshot == null) unknownProfitCount++;
    else knownProfit += cents(income) - cents(entry.costAmountSnapshot);
    const row = base(entry);
    delete row.costAmountSnapshot;
    const allocated = activeExpenses
      .flatMap(e => e.allocations)
      .filter(a => a.saleUnitId === row.id)
      .reduce((sum, a) => sum + cents(a.amount), 0n);
    Object.assign(row, {
      saleUnitId: row.id,
      unitId: unit.id,
      serialNumber: unit.serialNumber,
      productId: unit.productId,
      product: byId(g.StockProduct, unit.productId),
      fromLocation: byId(g.StockLocation, row.fromLocationId),
    });
    if (entry.saleAmount) total += cents(entry.saleAmount);
    if (entry.costAmountSnapshot == null) unknownCount++;
    else {
      knownCost += cents(entry.costAmountSnapshot);
    }
    if (ctx.permissions.has('stock.cost.read')) row.costAmount = entry.costAmountSnapshot;
    if (ctx.permissions.has('stock.expenses.read')) row.expenseAmount = money(allocated);
    if (ctx.permissions.has('stock.profit.read')) {
      row.grossProfit =
        entry.costAmountSnapshot == null || income == null
          ? null
          : money(cents(income) - cents(entry.costAmountSnapshot));
      row.profitAfterExpenses =
        row.grossProfit == null
          ? null
          : money(cents(row.grossProfit, { signed: true }) - (sale.simpleLedger ? 0n : allocated));
    }
    return row;
  });
  Object.assign(result, {
    lines: lines
      .filter(line => sale.status !== 'shipped' || units.some(unit => unit.saleLineId === line.id))
      .map(line => ({
        ...base(line),
        product: byId(g.StockProduct, line.productId),
        units: units.filter(unit => unit.saleLineId === line.id),
      })),
    units,
    totalAmount: money(total),
    customer: party(ctx, byId(g.StockParty, sale.customerId)),
    salesperson: party(ctx, byId(g.StockParty, sale.salespersonId)),
    handler: party(ctx, byId(g.StockParty, sale.handlerId)),
    allowedActions: allowed(ctx, [
      ['edit', 'stock.sales.edit'],
      ['reserve', 'stock.sales.edit'],
      ['cancel', 'stock.sales.edit'],
      ['picks', 'stock.sales.ship'],
      ['ship', 'stock.sales.ship'],
      ['expenses', 'stock.expenses.edit'],
      ['collection', 'stock.collections.edit'],
      ['correct', 'stock.correct'],
    ]),
  });
  if (ctx.permissions.has('stock.cost.read')) {
    result.confirmedCostAmount = money(knownCost);
    result.unconfirmedCostCount = unknownCount;
  }
  if (ctx.permissions.has('stock.expenses.read')) {
    result.expenses = expenses;
    result.expenseAmount = money(activeExpenses.reduce((sum, e) => sum + cents(e.amount), 0n));
  }
  if (ctx.permissions.has('stock.profit.read')) {
    result.partialGrossProfit = money(knownProfit);
    result.unconfirmedProfitCount = unknownProfitCount;
    result.grossProfit = unknownProfitCount ? null : result.partialGrossProfit;
    result.profitAfterExpenses =
      result.grossProfit == null
        ? null
        : money(knownProfit - (sale.simpleLedger ? 0n : cents(result.expenseAmount)));
  }
  if (ctx.permissions.has('stock.collections.read'))
    result.collections = g.StockCollection.filter(row => row.saleId === sale.id).map(row =>
      projectCollection(ctx, row, g)
    );
  return result;
}
/** 付款事实不隐含任何公司到账，按资金权限投影。 */
function projectCollection(ctx, row, g) {
  const result = {
    ...base(row),
    notes: decrypt(row.notesCiphertext),
    saleNo: byId(g.StockSale, row.saleId)?.saleNo,
    collector: party(ctx, byId(g.StockParty, row.collectorId)),
  };
  if (ctx.permissions.has('stock.receipts.read')) {
    const received = g.StockReceiptAllocation.filter(
      a => a.collectionId === row.id && a.status === 'active'
    ).reduce((sum, a) => sum + cents(a.amount), 0n);
    result.receivedAmount = money(received);
    result.outstandingAmount = money(row.status === 'posted' ? cents(row.amount) - received : 0n);
  }
  return result;
}
/** 到账及余额。 */
function projectReceipt(ctx, row, g) {
  const allocations = g.StockReceiptAllocation.filter(
    a => a.receiptId === row.id && a.status === 'active'
  ).map(a => {
    const su = byId(g.StockSaleUnit, a.saleUnitId);
    return { ...base(a), serialNumber: byId(g.StockUnit, su?.stockUnitId)?.serialNumber };
  });
  const amount = allocations.reduce((sum, a) => sum + cents(a.amount), 0n);
  return {
    ...base(row),
    notes: decrypt(row.notesCiphertext),
    payer: party(ctx, byId(g.StockParty, row.payerId)),
    allocations,
    allocatedAmount: money(amount),
    unallocatedAmount: money(row.status === 'posted' ? cents(row.amount) - amount : 0n),
    allowedActions: allowed(ctx, [
      ['allocate', 'stock.receipts.edit'],
      ['correct', 'stock.correct'],
    ]),
  };
}
/** 白名单事件投影不能泄露历史字段或原始密文。 */
function projectEvent(ctx, event) {
  const values = event.toJSON ? event.toJSON() : event;
  const domain = values.entityType;
  const permission = {
    StockSale: 'stock.sales.read',
    StockSaleUnit: 'stock.sales.read',
    StockSaleLine: 'stock.sales.read',
    StockExpense: 'stock.expenses.read',
    StockExpenseAllocation: 'stock.expenses.read',
    StockCollection: 'stock.collections.read',
    StockReceipt: 'stock.receipts.read',
    StockReceiptAllocation: 'stock.receipts.read',
    StockOfficialPrice: 'stock.cost.read',
  }[domain];
  if (permission && !ctx.permissions.has(permission)) return null;
  const changes = decryptJson(values.changesCiphertext);
  function prune(value) {
    if (Array.isArray(value)) return value.map(prune);
    if (!value || typeof value !== 'object') return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        key.endsWith('Ciphertext') ||
        [
          'orderId',
          'sourceOrderId',
          'bindingId',
          'sourceOrder',
          'sourceBinding',
          'beforeSource',
          'afterSource',
          'orderNumberText',
        ].includes(key)
      )
        continue;
      if (/cost|acquiredOn|priceId/i.test(key) && !ctx.permissions.has('stock.cost.read')) continue;
      if (/profit/i.test(key) && !ctx.permissions.has('stock.profit.read')) continue;
      if (/expense/i.test(key) && !ctx.permissions.has('stock.expenses.read')) continue;
      if (
        ['paymentVerification', 'pendingCollectorId', 'pendingCollectedAt'].includes(key) &&
        (!ctx.permissions.has('stock.collections.read') ||
          !ctx.permissions.has('stock.receipts.read'))
      )
        continue;
      if (key === 'reason' && !ctx.permissions.has('stock.correct')) continue;
      output[key] = prune(child);
    }
    return output;
  }
  const result = base(values);
  delete result.changesCiphertext;
  result.changes = prune(changes);
  return result;
}
function values(query, key) {
  if (query[key] === undefined || query[key] === '') return null;
  let list;
  try {
    list = Array.isArray(query[key]) ? query[key] : JSON.parse(query[key]);
  } catch (_error) {
    throw ApiError.badRequest(`${key}必须是数组`);
  }
  const result = array(list, 100, true);
  if (/Ids$/.test(key)) result.forEach(id => uuid(id));
  return result;
}

function page(rows, query = {}) {
  const pageNumber = Number(query.page || 1);
  const size = Number(query.pageSize || 20);
  if (
    !Number.isInteger(pageNumber) ||
    pageNumber < 1 ||
    (![20, 50, 100].includes(size) && !(query.internalExport === true && size === 5000))
  )
    throw ApiError.badRequest('分页参数无效');
  const sorted = [...rows].sort(
    (a, b) =>
      +new Date(b.createdAt) - +new Date(a.createdAt) || String(b.id).localeCompare(String(a.id))
  );
  return {
    items: sorted.slice((pageNumber - 1) * size, pageNumber * size),
    total: rows.length,
    page: pageNumber,
    pageSize: size,
  };
}
/** 库存列表按同一字段规则筛选与分页。 */
async function listUnits(ctx, query = {}) {
  try {
    requirePermissions(ctx, 'stock.read');
    const where = {};
    const states = values(query, 'states');
    const productIds = values(query, 'productIds');
    const locationIds = values(query, 'locationIds');
    where.state = states ? { [Op.in]: states } : { [Op.ne]: 'registered' };
    if (productIds) where.productId = productIds;
    if (locationIds) where.locationId = locationIds;
    if (query.q)
      where.serialNumber = {
        [Op.like]: `%${String(query.q)
          .trim()
          .toUpperCase()
          .replace(/[\\%_]/g, '\\$&')}%`,
      };
    if (query.sourceLinked !== undefined) {
      if (!['true', 'false'].includes(String(query.sourceLinked)))
        throw ApiError.badRequest('来源筛选无效');
      where[Op.and] = db.sequelize.literal(
        `${String(query.sourceLinked) === 'true' ? '' : 'NOT '}EXISTS(SELECT 1 FROM pickup_devices p WHERE p.stock_unit_id="StockUnit".id)`
      );
    }
    const result = await databasePage(ctx, 'StockUnit', where, query);
    const g = await graph(ctx, { unitIds: result.rows.map(r => r.id) });
    const { rows, ...meta } = result;
    return { ...meta, items: rows.map(row => projectUnit(ctx, row, g)) };
  } catch (error) {
    logger.debug('库存列表失败', { code: error.code || error.name });
    throw error;
  }
}
/** 单台详情授权后附加可访问附件和事件。 */
async function unitDetail(ctx, id) {
  try {
    requirePermissions(ctx, 'stock.read');
    const g = await graph(ctx, { unitIds: [id] });
    const row = byId(g.StockUnit, id);
    if (!row) throw ApiError.notFound();
    const result = projectUnit(ctx, row, g);
    result.events = (
      await db.StockEvent.findAll({
        where: { entityType: 'StockUnit', entityId: id },
        order: [['createdAt', 'DESC']],
        limit: 100,
        transaction: ctx.transaction,
      })
    )
      .map(e => projectEvent(ctx, e))
      .filter(Boolean);
    result.attachments = await attachments(ctx, 'unitId', id);
    if (row.state === 'in_transit') {
      const active = await db.StockTransferUnit.findOne({
        where: { stockUnitId: id, status: 'in_transit' },
        transaction: ctx.transaction,
      });
      if (active) {
        const transfer = await transferDetail(ctx, active.transferId);
        result.transfer = {
          id: transfer.id,
          status: transfer.status,
          fromLocation: transfer.fromLocation,
          toLocation: transfer.toLocation,
          originLabel: transfer.originLabel,
        };
      }
    }
    return result;
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockProjectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
async function attachments(ctx, field, id) {
  try {
    return await require('./stockEvidenceService').listAttachmentMetadata(ctx, field, id);
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockProjectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 销售列表。 */
async function listSales(ctx, query = {}) {
  try {
    requirePermissions(ctx, 'stock.sales.read');
    const where = {};
    if (query.q) where.saleNo = { [Op.iLike]: `%${String(query.q).trim().replace(/[%_]/g, '')}%` };
    for (const key of ['channel', 'status', 'customerId', 'salespersonId'])
      if (query[key]) where[key] = query[key];
    dateWhere(query, choice(query.dateField || 'createdAt', ['createdAt', 'shippedAt']), where);
    const result = await databasePage(ctx, 'StockSale', where, query);
    const g = await graph(ctx, { saleIds: result.rows.map(r => r.id) });
    const { rows, ...meta } = result;
    return { ...meta, items: rows.map(row => projectSale(ctx, row, g)) };
  } catch (error) {
    logger.debug('销售列表失败', { code: error.code || error.name });
    throw error;
  }
}
/** 销售详情。 */
async function saleDetail(ctx, id) {
  try {
    requirePermissions(ctx, 'stock.sales.read');
    const g = await graph(ctx, { saleIds: [id] });
    const row = byId(g.StockSale, id);
    if (!row) throw ApiError.notFound();
    const result = projectSale(ctx, row, g);
    result.attachments = await attachments(ctx, 'saleId', id);
    return result;
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockProjectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 客户付款列表。 */
async function listCollections(ctx, query = {}) {
  try {
    requirePermissions(ctx, 'stock.collections.read');
    const where = {};
    for (const key of ['saleId', 'collectorId', 'destination', 'status'])
      if (query[key]) where[key] = query[key];
    dateWhere(query, 'receivedAt', where);
    const result = await databasePage(ctx, 'StockCollection', where, query);
    const g = await graph(ctx, { collectionIds: result.rows.map(r => r.id) });
    const { rows, ...meta } = result;
    return { ...meta, items: rows.map(row => projectCollection(ctx, row, g)) };
  } catch (error) {
    logger.debug('付款列表失败', { code: error.code || error.name });
    throw error;
  }
}
/** 客户付款详情及受控凭证。 */
async function collectionDetail(ctx, id) {
  try {
    requirePermissions(ctx, 'stock.collections.read');
    uuid(id);
    const g = await graph(ctx, { collectionIds: [id] });
    const row = byId(g.StockCollection, id);
    if (!row) throw ApiError.notFound();
    return {
      ...projectCollection(ctx, row, g),
      attachments: await attachments(ctx, 'collectionId', id),
    };
  } catch (error) {
    logger.debug('付款详情失败', { code: error.code || error.name });
    throw error;
  }
}
/** 费用详情及当前版本分摊和受控凭证。 */
async function expenseDetail(ctx, id) {
  try {
    requirePermissions(ctx, 'stock.expenses.read');
    const row = await getRow('StockExpense', id, ctx);
    const g = await graph(ctx, { saleIds: [row.saleId] });
    return {
      ...expensesFor(ctx, row.saleId, g).find(e => e.id === id),
      attachments: await attachments(ctx, 'expenseId', id),
    };
  } catch (error) {
    logger.debug('费用详情失败', { code: error.code || error.name });
    throw error;
  }
}
/** 到账列表。 */
async function listReceipts(ctx, query = {}) {
  try {
    requirePermissions(ctx, 'stock.receipts.read');
    const where = {};
    for (const key of ['payerId', 'source', 'status']) if (query[key]) where[key] = query[key];
    dateWhere(query, 'receivedAt', where);
    const result = await databasePage(ctx, 'StockReceipt', where, query);
    const g = await graph(ctx, { receiptIds: result.rows.map(r => r.id) });
    const { rows, ...meta } = result;
    return { ...meta, items: rows.map(row => projectReceipt(ctx, row, g)) };
  } catch (error) {
    logger.debug('到账列表失败', { code: error.code || error.name });
    throw error;
  }
}
/** 到账详情。 */
async function receiptDetail(ctx, id) {
  try {
    requirePermissions(ctx, 'stock.receipts.read');
    const g = await graph(ctx, { receiptIds: [id] });
    const row = byId(g.StockReceipt, id);
    if (!row) throw ApiError.notFound();
    const result = projectReceipt(ctx, row, g);
    result.attachments = await attachments(ctx, 'receiptId', id);
    return result;
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockProjectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 按代收人、销售和SN区分持款与未登记付款。 */
async function receivableSummary(ctx, query = {}) {
  try {
    requirePermissions(ctx, 'stock.receipts.read');
    const filters = [];
    const bind = {};
    if (query.collectorId) {
      uuid(query.collectorId);
      filters.push('c.collector_id= :collectorId');
      bind.collectorId = query.collectorId;
    }
    if (query.from) {
      filters.push('c.received_at>= :from');
      bind.from = instant(query.from);
    }
    if (query.to) {
      filters.push('c.received_at< :to');
      bind.to = instant(query.to);
    }
    const [rows] = await db.sequelize.query(
      `SELECT c.id AS "collectionId",c.collector_id AS "collectorId",c.sale_id AS "saleId",s.sale_no AS "saleNo",u.id AS "saleUnitId",p.serial_number AS "serialNumber",COALESCE(u.settlement_amount,u.sale_amount) AS "saleAmount",COALESCE(a.amount,0)::numeric(14,2) AS "receivedAmount" FROM stock_collections c JOIN stock_sales s ON s.id=c.sale_id JOIN stock_sale_lines l ON l.sale_id=s.id JOIN stock_sale_units u ON u.sale_line_id=l.id AND u.status='shipped' JOIN stock_units p ON p.id=u.stock_unit_id LEFT JOIN (SELECT collection_id,sale_unit_id,sum(amount) amount FROM stock_receipt_allocations WHERE status='active' GROUP BY collection_id,sale_unit_id) a ON a.collection_id=c.id AND a.sale_unit_id=u.id WHERE c.status='posted' AND c.destination='agent' ${filters.length ? 'AND ' + filters.join(' AND ') : ''} ORDER BY c.received_at,c.id,u.id`,
      { replacements: bind, transaction: ctx.transaction }
    );
    const ids = [...new Set(rows.map(r => r.collectorId))];
    const parties = await db.StockParty.findAll({
      where: { id: ids },
      transaction: ctx.transaction,
      raw: true,
    });
    const groups = new Map();
    for (const row of rows) {
      let group = groups.get(row.collectorId);
      if (!group) {
        group = {
          collectorId: row.collectorId,
          collector: party(ctx, byId(parties, row.collectorId)),
          collected: 0n,
          received: 0n,
          units: [],
        };
        groups.set(row.collectorId, group);
      }
      group.collected += cents(row.saleAmount);
      group.received += cents(row.receivedAmount);
      group.units.push({
        ...row,
        collectedAmount: row.saleAmount,
        outstandingAmount: money(cents(row.saleAmount) - cents(row.receivedAmount)),
      });
    }
    const [missing] = await db.sequelize.query(
      "SELECT count(*)::integer AS quantity FROM stock_sales s WHERE s.status='shipped' AND NOT EXISTS(SELECT 1 FROM stock_collections c WHERE c.sale_id=s.id AND c.status='posted')",
      { transaction: ctx.transaction }
    );
    return {
      items: [...groups.values()].map(({ collected, received, ...group }) => ({
        ...group,
        collectedAmount: money(collected),
        receivedAmount: money(received),
        outstandingAmount: money(collected - received),
      })),
      unregisteredCount: missing[0].quantity,
    };
  } catch (error) {
    logger.debug('待转回汇总失败', { code: error.code || error.name });
    throw error;
  }
}
/** 规格概览中代卖/在途与重庆可售分开。 */
async function summary(ctx, query = {}) {
  try {
    requirePermissions(ctx, 'stock.read');
    const where = {};
    const productIds = values(query, 'productIds');
    const modelKeys = values(query, 'modelKeys');
    const colors = values(query, 'colors');
    const locationIds = values(query, 'locationIds');
    if (productIds) where.id = productIds;
    if (modelKeys) where.modelKey = modelKeys;
    if (colors) where.colorKey = colors;
    const products = await db.StockProduct.findAll({
      where,
      transaction: ctx.transaction,
      raw: true,
    });
    const locations = await db.StockLocation.findAll({
      where: { kind: 'warehouse' },
      transaction: ctx.transaction,
      raw: true,
    });
    const [counts] = await db.sequelize.query(
      'SELECT u.product_id AS "productId",u.location_id AS "locationId",u.state,l.kind,count(*)::integer AS quantity FROM stock_units u LEFT JOIN stock_locations l ON l.id=u.location_id WHERE u.state IN (\'in_stock\',\'in_transit\') GROUP BY u.product_id,u.location_id,u.state,l.kind',
      { transaction: ctx.transaction }
    );
    const [reserved] = await db.sequelize.query(
      "SELECT l.product_id AS \"productId\",sum(l.quantity)::integer AS quantity FROM stock_sale_lines l JOIN stock_sales s ON s.id=l.sale_id WHERE s.status='reserved' AND s.channel='local' GROUP BY l.product_id",
      { transaction: ctx.transaction }
    );
    const items = products.map(product => {
      const rows = counts.filter(r => r.productId === product.id);
      const local = rows
        .filter(r => r.state === 'in_stock' && r.kind === 'warehouse')
        .reduce((sum, r) => sum + r.quantity, 0);
      const held = reserved.find(r => r.productId === product.id)?.quantity || 0;
      return {
        id: product.id,
        productId: product.id,
        product,
        quantity: local,
        onHand: local,
        reserved: held,
        available: local - held,
        Q: local,
        R: held,
        A: local - held,
        warehouses: locations
          .filter(l => !locationIds || locationIds.includes(l.id))
          .map(l => ({
            id: l.id,
            locationId: l.id,
            name: l.name,
            quantity: rows
              .filter(r => r.locationId === l.id)
              .reduce((sum, r) => sum + r.quantity, 0),
          })),
        consignment: rows
          .filter(r => r.kind === 'consignee')
          .reduce((sum, r) => sum + r.quantity, 0),
        inTransit: rows
          .filter(r => r.state === 'in_transit')
          .reduce((sum, r) => sum + r.quantity, 0),
        totalUnsold: rows.reduce((sum, r) => sum + r.quantity, 0),
      };
    });
    const settings = await db.StockSetting.findByPk(1, { transaction: ctx.transaction });
    return { items, enabled: settings.enabled };
  } catch (error) {
    logger.debug('库存汇总失败', { code: error.code || error.name });
    throw error;
  }
}
/** 基础选项不携带未授权价格或隐私。 */
async function catalog(ctx) {
  try {
    requirePermissions(ctx, 'stock.read');
    const [products, locations, parties, settings] = await Promise.all([
      db.StockProduct.findAll({ transaction: ctx.transaction, raw: true }),
      db.StockLocation.findAll({ transaction: ctx.transaction, raw: true }),
      db.StockParty.findAll({ transaction: ctx.transaction, raw: true }),
      db.StockSetting.findByPk(1, { transaction: ctx.transaction }),
    ]);
    return {
      products,
      locations,
      parties: parties.map(row => party(ctx, row)),
      enabled: settings.enabled,
      cutoverAt: settings.cutoverAt,
    };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockProjectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 流转明细。 */
async function transferDetail(ctx, id) {
  try {
    requirePermissions(ctx, 'stock.read');
    const g = await graph(ctx, { transferIds: [id] });
    const row = byId(g.StockTransfer, id);
    if (!row) throw ApiError.notFound();
    return {
      ...base(row),
      notes: decrypt(row.notesCiphertext),
      fromLocation: byId(g.StockLocation, row.fromLocationId),
      toLocation: byId(g.StockLocation, row.toLocationId),
      handler: party(ctx, byId(g.StockParty, row.handlerId)),
      units: g.StockTransferUnit.filter(u => u.transferId === id).map(u => ({
        ...base(u),
        unitId: u.stockUnitId,
        serialNumber: byId(g.StockUnit, u.stockUnitId)?.serialNumber,
        product: byId(g.StockProduct, byId(g.StockUnit, u.stockUnitId)?.productId),
      })),
    };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockProjectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 流转列表。 */
async function listTransfers(ctx, query = {}) {
  try {
    requirePermissions(ctx, 'stock.read');
    const where = {};
    for (const key of ['status', 'fromLocationId', 'toLocationId'])
      if (query[key]) where[key] = query[key];
    dateWhere(query, 'createdAt', where);
    const result = await databasePage(ctx, 'StockTransfer', where, query);
    const g = await graph(ctx, { transferIds: result.rows.map(r => r.id) });
    const { rows, ...meta } = result;
    return {
      ...meta,
      items: rows.map(row => ({
        ...base(row),
        fromLocation: byId(g.StockLocation, row.fromLocationId),
        toLocation: byId(g.StockLocation, row.toLocationId),
        unitCount: g.StockTransferUnit.filter(u => u.transferId === row.id).length,
      })),
    };
  } catch (error) {
    logger.debug('流转列表失败', { code: error.code || error.name });
    throw error;
  }
}
/** 分页审计，使用当前字段权限。 */
async function listEvents(ctx, type, id, query = {}) {
  try {
    requirePermissions(ctx, type === 'StockSale' ? 'stock.sales.read' : 'stock.read');
    await getRow(type, id, ctx);
    const rows = await db.StockEvent.findAll({
      where: { entityType: type, entityId: id },
      transaction: ctx.transaction,
    });
    return page(rows.map(row => projectEvent(ctx, row)).filter(Boolean), query);
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockProjectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 只按实际发生时间统计销售与到账，不混淆两种金额。 */
async function reports(ctx, kind, query = {}) {
  try {
    requirePermissions(ctx, kind === 'receipts' ? 'stock.receipts.read' : 'stock.sales.read');
    const filters = [];
    const replacements = {};
    const date = kind === 'receipts' ? 'r.received_at' : 's.shipped_at';
    if (query.from) {
      filters.push(`${date}>= :from`);
      replacements.from = instant(query.from);
    }
    if (query.to) {
      filters.push(`${date}< :to`);
      replacements.to = instant(query.to);
    }
    if (replacements.from && replacements.to && +replacements.from >= +replacements.to)
      throw ApiError.badRequest('日期区间无效');
    if (kind === 'receipts') {
      if (query.payerId) {
        uuid(query.payerId);
        filters.push('r.payer_id= :payerId');
        replacements.payerId = query.payerId;
      }
      const [rows] = await db.sequelize.query(
        `SELECT count(*)::integer AS quantity,COALESCE(sum(r.amount),0)::numeric(30,2)::text AS amount,COALESCE(sum(r.amount-COALESCE(a.amount,0)),0)::numeric(30,2)::text AS unallocated FROM stock_receipts r LEFT JOIN (SELECT receipt_id,sum(amount) amount FROM stock_receipt_allocations WHERE status='active' GROUP BY receipt_id) a ON a.receipt_id=r.id WHERE r.status='posted' ${filters.length ? 'AND ' + filters.join(' AND ') : ''}`,
        { replacements, transaction: ctx.transaction }
      );
      return {
        quantity: rows[0].quantity,
        totalAmount: money(BigInt(rows[0].amount.replace('.', ''))),
        unallocatedAmount: money(BigInt(rows[0].unallocated.replace('.', ''))),
      };
    }
    if (query.channel) {
      choice(query.channel, ['local', 'consignment']);
      filters.push('s.channel= :channel');
      replacements.channel = query.channel;
    }
    if (query.salespersonId) {
      uuid(query.salespersonId);
      filters.push('s.salesperson_id= :person');
      replacements.person = query.salespersonId;
    }
    const ids = values(query, 'productIds');
    if (ids?.length) {
      filters.push('l.product_id IN (:products)');
      replacements.products = ids;
    }
    const [rows] = await db.sequelize.query(
      `SELECT count(*)::integer AS quantity,count(DISTINCT s.id) FILTER(WHERE NOT s.fees_complete)::integer AS "incompleteFeesCount",COALESCE(sum(u.sale_amount),0)::numeric(30,2)::text AS amount,COALESCE(sum(u.cost_amount_snapshot),0)::numeric(30,2)::text AS cost,count(*) FILTER(WHERE u.cost_amount_snapshot IS NULL)::integer AS unknown,count(*) FILTER(WHERE u.cost_amount_snapshot IS NULL OR (s.simple_ledger AND u.settlement_amount IS NULL))::integer AS "unknownProfit",COALESCE(sum((CASE WHEN s.simple_ledger THEN u.settlement_amount ELSE u.sale_amount END)-u.cost_amount_snapshot),0)::numeric(30,2)::text AS gross,COALESCE(sum(a.amount),0)::numeric(30,2)::text AS expense,COALESCE(sum(CASE WHEN s.simple_ledger THEN 0 ELSE a.amount END),0)::numeric(30,2)::text AS "profitExpense" FROM stock_sales s JOIN stock_sale_lines l ON l.sale_id=s.id JOIN stock_sale_units u ON u.sale_line_id=l.id AND u.status='shipped' LEFT JOIN (SELECT a.sale_unit_id,sum(a.amount) amount FROM stock_expense_allocations a JOIN stock_expenses e ON e.id=a.expense_id AND e.version=a.expense_version AND e.status='active' GROUP BY a.sale_unit_id) a ON a.sale_unit_id=u.id WHERE s.status='shipped' ${filters.length ? 'AND ' + filters.join(' AND ') : ''}`,
      { replacements, transaction: ctx.transaction }
    );
    const row = rows[0];
    const output = {
      quantity: row.quantity,
      totalAmount: row.amount,
      incompleteFeesCount: row.incompleteFeesCount,
    };
    if (ctx.permissions.has('stock.cost.read')) {
      output.confirmedCostAmount = row.cost;
      output.unconfirmedCostCount = row.unknown;
    }
    if (ctx.permissions.has('stock.profit.read')) {
      output.partialGrossProfit = row.gross;
      output.unconfirmedProfitCount = row.unknownProfit;
      output.grossProfit = row.unknownProfit ? null : row.gross;
      output.profitAfterExpenses = row.unknownProfit
        ? null
        : money(BigInt(row.gross.replace('.', '')) - BigInt(row.profitExpense.replace('.', '')));
    }
    return output;
  } catch (error) {
    logger.debug('库存报表失败', { code: error.code || error.name });
    throw error;
  }
}
module.exports = {
  collectionDetail,
  expenseDetail,
  unitsByIds,
  graph,
  projectUnit,
  projectSale,
  projectReceipt,
  projectEvent,
  listUnits,
  unitDetail,
  listSales,
  saleDetail,
  listCollections,
  listReceipts,
  receiptDetail,
  receivableSummary,
  summary,
  catalog,
  transferDetail,
  listTransfers,
  listEvents,
  reports,
};
