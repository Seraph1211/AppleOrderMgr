const {
  LEDGER_SQL,
  ELIGIBLE_SQL,
  ISSUES,
  assertLifecycleWritable,
} = require('./stockLifecycleRules');
const { Op } = require('sequelize');
const { parseStockProductFilters } = require('../utils/stockProductFilters');
const { specification, PRICE_VERSION } = require('./stockFixedCatalog');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/fieldEncryption');
const { cents, money } = require('../utils/stockMoney');
const { only, choice, text, uuid, dateOnly } = require('../utils/stockRules');
const { requirePermissions } = require('./stockCommandService');
const { scopeOrderWhere } = require('./orderAccessService');
const oldProjection = require('./stockProjectionService');
const { dateLabel } = require('./stockLedgerService');
const get = (rows, id) => rows.find(row => row.id === id) || null;
const locationDto = row =>
  row && row.kind === 'warehouse' ? { id: row.id, name: row.name } : null;
const has = (ctx, ...permissions) => permissions.every(code => ctx.permissions.has(code));

/** 库内可选资料保持简单，不下发客户联系方式或配置秘密。 */
async function catalog(ctx) {
  try {
    requirePermissions(ctx, 'stock.read');
    const products = await db.StockProduct.findAll({
      where: { isActive: true },
      attributes: ['id', 'modelName', 'storageGb', 'colorName', 'skuCode'],
      order: [['modelName', 'ASC']],
      transaction: ctx.transaction,
      raw: true,
    });
    const filterProducts = await db.StockProduct.findAll({
      attributes: ['modelName', 'storageGb', 'colorName'],
      transaction: ctx.transaction,
      raw: true,
    });
    const filterOptions = {
      modelNames: [...new Set(filterProducts.map(product => product.modelName))].sort(),
      storageGbs: [...new Set(filterProducts.map(product => product.storageGb))].sort(
        (a, b) => a - b
      ),
      colorNames: [...new Set(filterProducts.map(product => product.colorName))].sort(),
    };
    const warehouses = await db.StockLocation.findAll({
      where: { kind: 'warehouse', isActive: true },
      attributes: ['id', 'name', 'version', 'isActive'],
      order: [['name', 'ASC']],
      transaction: ctx.transaction,
      raw: true,
    });
    let people = [];
    if (has(ctx, 'stock.sales.read') || has(ctx, 'stock.catalog.manage'))
      people = await db.StockParty.findAll({
        where: { isActive: true, partyType: { [Op.in]: ['internal_person', 'external_person'] } },
        attributes: ['id', 'name', 'roles', 'version', 'partyType', 'isActive'],
        order: [['name', 'ASC']],
        transaction: ctx.transaction,
        raw: true,
      });
    const settings = await db.StockSetting.findByPk(1, { transaction: ctx.transaction });
    return {
      products: products.map(product => {
        const spec = specification(product);
        return {
          ...product,
          entryEligible: Boolean(spec),
          ...(spec && has(ctx, 'stock.cost.read')
            ? { fixedCostAmount: spec.amount, priceVersion: PRICE_VERSION }
            : {}),
        };
      }),
      filterOptions,
      warehouses,
      statisticWarehouses: await db.StockLocation.findAll({
        where: { kind: 'warehouse' },
        attributes: ['id', 'name'],
        transaction: ctx.transaction,
        raw: true,
      }),
      people,
      enabled: settings.enabled,
      ...(has(ctx, 'stock.settings.manage') ? { settingsVersion: settings.version } : {}),
    };
  } catch (error) {
    logger.debug('简化资料读取失败', { code: error.code || error.name });
    throw error;
  }
}
function financialFacts(sale, saleUnit, g, receiptAllocations) {
  const lines = g.StockSaleLine.filter(row => row.saleId === sale.id);
  const items = g.StockSaleUnit.filter(
    row => lines.some(line => line.id === row.saleLineId) && row.status === 'shipped'
  );
  const collections = g.StockCollection.filter(
    row => row.saleId === sale.id && row.status === 'posted'
  );
  const allocations = g.StockReceiptAllocation.filter(
    row => row.status === 'active' && collections.some(c => c.id === row.collectionId)
  );
  const receipts = g.StockReceipt.filter(
    row =>
      row.status === 'posted' &&
      (allocations.some(a => a.receiptId === row.id) ||
        collections.some(c => c.id === row.collectionId))
  );
  const amount = allocations
    .filter(row => row.saleUnitId === saleUnit.id)
    .reduce((sum, row) => sum + cents(row.amount), 0n);
  let compatible =
    items.length === 1 &&
    collections.length <= 1 &&
    receipts.length <= 1 &&
    (amount === 0n || amount === cents(saleUnit.settlementAmount ?? saleUnit.saleAmount));
  if (collections.some(row => row.amount !== (saleUnit.settlementAmount ?? saleUnit.saleAmount)))
    compatible = false;
  if (allocations.some(row => row.saleUnitId !== saleUnit.id)) compatible = false;
  for (const receipt of receipts) {
    const related = receiptAllocations.filter(
      row => row.receiptId === receipt.id && row.status === 'active'
    );
    if (
      related.length !== 1 ||
      related[0].saleUnitId !== saleUnit.id ||
      related[0].amount !== receipt.amount ||
      receipt.amount !== (saleUnit.settlementAmount ?? saleUnit.saleAmount)
    )
      compatible = false;
  }
  const collection = collections[0] || null;
  const receipt =
    receipts
      .filter(row => allocations.some(a => a.saleUnitId === saleUnit.id && a.receiptId === row.id))
      .sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0))[0] || null;
  let status = !sale.simpleLedger || sale.paymentVerification === 'unknown' ? 'unknown' : 'unpaid';
  if (collection || sale.pendingCollectorId) status = 'agent_pending';
  if (amount > 0n && amount >= cents(saleUnit.settlementAmount ?? saleUnit.saleAmount))
    status = 'company_received';
  else if (amount > 0n) status = 'legacy_partial';
  return { compatible, collection, receipt, status };
}
function project(ctx, unit, g, allAllocations) {
  const saleUnit = g.StockSaleUnit.find(
    row => row.stockUnitId === unit.id && row.status === 'shipped'
  );
  const line = get(g.StockSaleLine, saleUnit?.saleLineId);
  const sale = get(g.StockSale, line?.saleId);
  const location = get(g.StockLocation, unit.locationId);
  if (
    !(unit.state === 'in_stock' && location?.kind === 'warehouse') &&
    !(unit.state === 'sold' && sale?.channel === 'local') &&
    !(unit.state === 'registered' && g.eligibleIds?.has(unit.id)) &&
    unit.state !== 'returned'
  )
    return null;
  const product = get(g.StockProduct, unit.productId);
  const binding = g.PickupDevice.find(
    row => row.stockUnitId === unit.id || row.serialNumber === unit.serialNumber
  );
  const order = get(g.Order, binding?.orderId);
  const result = {
    id: unit.id,
    deviceNumber: unit.deviceNumber,
    version: unit.version,
    serialNumber: unit.serialNumber,
    state: unit.state,
    product: null,
    warehouse: locationDto(
      unit.state === 'returned' ? get(g.StockLocation, unit.returnLocationId) : location
    ),
    returnedAt: unit.returnedAt,
    returnPreviousState: unit.returnPreviousState,
    lifecycleIssue: unit.lifecycleIssue,
    lifecycleMessage: ISSUES[unit.lifecycleIssue] || null,
    check: g.checks?.get(unit.id) || null,
    receivedOn: dateLabel(unit.firstReceivedAt),
    notes: decrypt(unit.notesCiphertext),
    orderLinked: Boolean(binding),
    allowedActions: [],
    compatibilityReason: null,
  };
  if (product)
    result.product = {
      id: product.id,
      modelName: product.modelName,
      storageGb: product.storageGb,
      colorName: product.colorName,
    };
  if (has(ctx, 'orders.read')) {
    result.orderNumber = binding ? order?.orderNumber || null : unit.orderNumberText || null;
    result.orderId = order?.id || null;
  }
  if (has(ctx, 'stock.cost.read'))
    Object.assign(result, {
      officialCostAmount: unit.officialCostAmount,
      acquiredOn: unit.acquiredOn,
      costStatus: unit.costStatus,
      costSource: unit.costSource,
      priceId: unit.priceId,
    });
  if (has(ctx, 'stock.expenses.read')) result.extraExpenseAmount = unit.extraExpenseAmount;
  if (['in_stock', 'sold'].includes(unit.state) && has(ctx, 'stock.receive'))
    result.allowedActions.push('edit');
  if (order && has(ctx, 'stock.correct', 'stock.receive', 'orders.read')) {
    if (unit.lifecycleIssue === 'return_pending') result.allowedActions.push('confirm_return');
    if (['sold_return_conflict', 'return_withdrawn'].includes(unit.lifecycleIssue))
      result.allowedActions.push('resolve_return');
  }
  if (unit.state === 'registered' && !unit.lifecycleIssue && has(ctx, 'stock.receive'))
    result.allowedActions.push('receive');
  if (!sale) {
    const picked = g.StockSaleUnit.some(
      row => row.stockUnitId === unit.id && row.status === 'picked'
    );
    if (picked) result.compatibilityReason = '该设备已有旧销售占用，请先处理原记录';
    if (
      unit.state === 'in_stock' &&
      !unit.lifecycleIssue &&
      !picked &&
      has(ctx, 'stock.sales.edit', 'stock.sales.ship')
    )
      result.allowedActions.push('sell');
    return result;
  }
  if (!has(ctx, 'stock.sales.read')) return result;
  const facts = financialFacts(sale, saleUnit, g, allAllocations);
  if (!facts.compatible)
    result.compatibilityReason = '该旧记录存在共用销售或资金关系，暂不适用单台销售及货款更正';
  Object.assign(result, {
    saleId: sale.id,
    soldOn: dateLabel(sale.shippedAt),
    salespersonName: get(g.StockParty, sale.salespersonId)?.name || null,
    handlerName: get(g.StockParty, sale.handlerId)?.name || null,
    saleAmount: saleUnit.saleAmount,
    settlementAmount: saleUnit.settlementAmount,
    sourceWarehouse: locationDto(get(g.StockLocation, saleUnit.fromLocationId)),
    isHistorical: sale.isHistorical,
  });
  if (has(ctx, 'stock.expenses.read') && !sale.simpleLedger) {
    const expenses = g.StockExpense.filter(
      row => row.saleId === sale.id && row.status === 'active'
    );
    const amount = g.StockExpenseAllocation.filter(
      row =>
        row.saleUnitId === saleUnit.id &&
        expenses.some(e => e.id === row.expenseId && e.version === row.expenseVersion)
    ).reduce((sum, row) => sum + cents(row.amount), 0n);
    result.extraExpenseAmount = expenses.length ? money(amount) : null;
  }
  if (has(ctx, 'stock.profit.read')) {
    result.grossProfit =
      saleUnit.costAmountSnapshot == null || saleUnit.settlementAmount == null
        ? null
        : money(cents(saleUnit.settlementAmount) - cents(saleUnit.costAmountSnapshot));
    // 兼容旧字段；人工结算已扣费，禁止重复扣除。
    result.profitAfterExpenses = result.grossProfit;
  }
  if (has(ctx, 'stock.collections.read', 'stock.receipts.read')) {
    Object.assign(result, {
      paymentStatus: facts.status,
      collectorName:
        get(g.StockParty, facts.collection?.collectorId || sale.pendingCollectorId)?.name || null,
      collectedOn: dateLabel(facts.collection?.receivedAt || sale.pendingCollectedAt),
      companyReceivedOn: dateLabel(facts.receipt?.receivedAt),
    });
    if (facts.compatible && has(ctx, 'stock.collections.edit'))
      result.allowedActions.push('payment');
    if (
      facts.compatible &&
      has(
        ctx,
        'stock.correct',
        'stock.sales.ship',
        'stock.receive',
        'stock.collections.edit',
        'stock.receipts.edit',
        'stock.expenses.edit'
      )
    )
      result.allowedActions.push('recover');
  }
  return result;
}
/** 用一组批量关联读取投影多台，避免逐行N+1和权限泄漏。 */
async function byIds(ctx, ids) {
  try {
    requirePermissions(ctx, 'stock.read');
    if (!ids.length) return [];
    const graph = await oldProjection.graph(ctx, { unitIds: ids });
    const [eligible] = await db.sequelize.query(
      `SELECT u.id FROM stock_units u WHERE u.id IN (:ids) AND ${ELIGIBLE_SQL}`,
      { replacements: { ids }, transaction: ctx.transaction }
    );
    graph.eligibleIds = new Set(eligible.map(row => row.id));
    const [checks] = await db.sequelize.query(
      `SELECT d.stock_unit_id AS id,
      c.checked_at AS "checkedAt",c.observed_at AS "observedAt",
      c.error_code AS "errorCode",'system_order_status' AS source
      FROM pickup_devices d LEFT JOIN stock_order_checks c ON c.order_id=d.order_id
      WHERE d.stock_unit_id IN (:ids)`,
      { replacements: { ids }, transaction: ctx.transaction }
    );
    graph.checks = new Map(checks.map(({ id, ...check }) => [id, check]));
    // 兼容性需要核对真实资金关系；仅内部查询，投影仍严格按原权限裁剪金额与状态。
    if (!has(ctx, 'stock.collections.read', 'stock.receipts.read') && graph.StockSale.length) {
      graph.StockCollection = await db.StockCollection.findAll({
        where: { saleId: graph.StockSale.map(row => row.id) },
        transaction: ctx.transaction,
        raw: true,
      });
      const collectionIds = graph.StockCollection.map(row => row.id);
      graph.StockReceiptAllocation = await db.StockReceiptAllocation.findAll({
        where: { collectionId: collectionIds },
        transaction: ctx.transaction,
        raw: true,
      });
      graph.StockReceipt = await db.StockReceipt.findAll({
        where: {
          [Op.or]: [
            { id: graph.StockReceiptAllocation.map(row => row.receiptId) },
            { collectionId: collectionIds },
          ],
        },
        transaction: ctx.transaction,
        raw: true,
      });
    }
    const receiptIds = graph.StockReceipt.map(row => row.id);
    let allocations = [];
    if (receiptIds.length)
      allocations = await db.StockReceiptAllocation.findAll({
        where: { receiptId: receiptIds, status: 'active' },
        transaction: ctx.transaction,
        raw: true,
      });
    return ids
      .map(id => {
        const unit = get(graph.StockUnit, id);
        return unit ? project(ctx, unit, graph, allocations) : null;
      })
      .filter(Boolean);
  } catch (error) {
    logger.debug('简化台账读取失败', { code: error.code || error.name });
    throw error;
  }
}
/** 精确 SN 出库预览；未入库身份只返回核对需要的白名单字段。 */
async function dispatchPreview(ctx, query) {
  try {
    requirePermissions(ctx, 'stock.read', 'stock.sales.edit', 'stock.sales.ship');
    only(query, ['serialNumber']);
    const serialNumber = require('./pickupDeviceRules').normalizeDeviceBarcodes({
      serialBarcode: query.serialNumber,
    }).serialNumber;
    const unit = await db.StockUnit.findOne({
      where: { serialNumber },
      transaction: ctx.transaction,
    });
    if (!unit) return { needsReceive: true, unit: null };
    assertLifecycleWritable(unit);
    if (!['registered', 'in_stock'].includes(unit.state))
      throw ApiError.conflict(
        '该设备已售出或不在可出库状态，请查看原记录',
        undefined,
        'UNIT_STATE_CONFLICT'
      );
    if (unit.state === 'in_stock') {
      const row = (await byIds(ctx, [unit.id]))[0];
      if (!row || !row.allowedActions.includes('sell'))
        throw ApiError.conflict('该设备不是可售现货或已有销售占用，请处理原记录');
      return { needsReceive: false, unit: row };
    }
    let product = null;
    if (unit.productId) {
      product = await db.StockProduct.findByPk(unit.productId, {
        attributes: ['id', 'modelName', 'storageGb', 'colorName'],
        transaction: ctx.transaction,
      });
    }
    return {
      needsReceive: true,
      unit: {
        id: unit.id,
        version: unit.version,
        serialNumber,
        product,
        ...(has(ctx, 'stock.cost.read') ? { officialCostAmount: unit.officialCostAmount } : {}),
      },
    };
  } catch (error) {
    logger.debug('出库预览失败', { code: error.code || error.name });
    throw error;
  }
}
/** 单台详情只展示本台可访问业务事件，不把内部原始对象作为用户输入。 */
async function detail(ctx, id) {
  try {
    uuid(id);
    const row = (await byIds(ctx, [id]))[0];
    if (!row) throw ApiError.notFound('该设备不在库存管理台账');
    const events = await db.StockEvent.findAll({
      where: {
        [Op.or]: [
          { entityType: 'StockUnit', entityId: id },
          ...(row.saleId ? [{ entityType: 'StockSale', entityId: row.saleId }] : []),
        ],
      },
      order: [['createdAt', 'DESC']],
      limit: 100,
      transaction: ctx.transaction,
    });
    row.events = events
      .map(event => oldProjection.projectEvent(ctx, event))
      .filter(Boolean)
      .map(event => ({ ...event, reason: event.changes?.reason || null }));
    return row;
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
/** 数据库分页与筛选，仓库现货和本地自销为唯一简化台账边界。 */
async function list(ctx, query = {}, statistics = false) {
  try {
    requirePermissions(ctx, 'stock.read');
    only(query, [
      'view',
      'q',
      'productId',
      'modelNames',
      'storageGbs',
      'colorNames',
      'warehouseId',
      'warehouseIds',
      'states',
      'salespersonName',
      'paymentStatus',
      'soldFrom',
      'soldTo',
      'page',
      'pageSize',
    ]);
    const view = choice(query.view || 'in_stock', [
      'registered',
      'in_stock',
      'sold',
      'returned',
      'all',
    ]);
    const page = Number(query.page || 1),
      pageSize = Number(query.pageSize || 20);
    if (!Number.isInteger(page) || page < 1 || ![20, 50, 100].includes(pageSize))
      throw ApiError.badRequest('分页参数无效');
    const replacements = { limit: pageSize, offset: (page - 1) * pageSize };
    const filters = [];
    const productFilters = parseStockProductFilters(query);
    for (const [key, column] of [
      ['modelNames', 'model_name'],
      ['storageGbs', 'storage_gb'],
      ['colorNames', 'color_name'],
    ]) {
      if (productFilters[key].length) {
        replacements[key] = productFilters[key];
        filters.push(`p.${column} IN (:${key})`);
      }
    }
    if (query.productId) {
      replacements.productId = uuid(query.productId);
      filters.push('u.product_id=:productId');
    }
    if (query.warehouseId) {
      replacements.warehouseId = uuid(query.warehouseId);
      filters.push('wl.id=:warehouseId');
    }
    for (const key of ['states', 'warehouseIds']) {
      if (!query[key]) continue;
      let values;
      try {
        values = JSON.parse(query[key]);
      } catch (_error) {
        throw ApiError.badRequest('多选筛选无效');
      }
      if (
        !Array.isArray(values) ||
        values.length > 100 ||
        values.some(value => typeof value !== 'string')
      )
        throw ApiError.badRequest('多选筛选无效');
      if (!values.length) continue;
      if (key === 'states') {
        values.forEach(value => choice(value, ['registered', 'in_stock', 'sold', 'returned']));
        replacements.states = values;
        filters.push('u.state IN (:states)');
      } else {
        const ids = values.filter(value => value !== 'unassigned').map(value => uuid(value));
        replacements.warehouseIds = ids;
        filters.push(
          `(${[
            ids.length ? 'wl.id IN (:warehouseIds)' : '',
            values.includes('unassigned') ? 'wl.id IS NULL' : '',
          ]
            .filter(Boolean)
            .join(' OR ')})`
        );
      }
    }
    let searchFilter = '';
    let searchText = '';
    if (query.q) {
      searchText = text(query.q, '搜索内容', 100).toLowerCase();
      replacements.search = `%${text(query.q, '搜索内容', 100).replace(/[\\%_]/g, '\\$&')}%`;
      let orderFilter = '';
      if (has(ctx, 'orders.read')) {
        const orders = await db.Order.findAll({
          where: scopeOrderWhere(ctx.user, { orderNumber: { [Op.iLike]: replacements.search } }),
          attributes: ['id'],
          transaction: ctx.transaction,
          raw: true,
        });
        replacements.orderIds = orders.map(row => row.id);
        orderFilter = ` OR (u.order_number_text ILIKE :search AND NOT EXISTS (SELECT 1 FROM pickup_devices b WHERE b.stock_unit_id=u.id))${orders.length ? ' OR EXISTS (SELECT 1 FROM pickup_devices b WHERE b.stock_unit_id=u.id AND b.order_id IN (:orderIds))' : ''}`;
      }
      searchFilter = `u.serial_number ILIKE :search${orderFilter}`;
    }
    if (query.salespersonName) {
      requirePermissions(ctx, 'stock.sales.read');
      replacements.seller = `%${text(query.salespersonName, '销售人', 100).replace(/[\\%_]/g, '\\$&')}%`;
      filters.push('sp.name ILIKE :seller');
    }
    if (query.soldFrom) {
      requirePermissions(ctx, 'stock.sales.read');
      replacements.soldFrom = `${dateOnly(query.soldFrom)}T00:00:00+08:00`;
      filters.push('s.shipped_at>=:soldFrom');
    }
    if (query.soldTo) {
      requirePermissions(ctx, 'stock.sales.read');
      replacements.soldTo = `${dateOnly(query.soldTo)}T00:00:00+08:00`;
      filters.push("s.shipped_at<CAST(:soldTo AS timestamptz)+INTERVAL '1 day'");
    }
    if (query.soldFrom && query.soldTo && query.soldFrom > query.soldTo)
      throw ApiError.badRequest('日期区间无效');
    if (query.paymentStatus) {
      requirePermissions(ctx, 'stock.collections.read', 'stock.receipts.read');
      replacements.paymentStatus = choice(query.paymentStatus, [
        'unpaid',
        'unknown',
        'agent_pending',
        'company_received',
        'legacy_partial',
      ]);
      // 正常全额状态按资金事实筛选；复杂旧记录在列表投影中显示兼容限制。
      filters.push(
        "s.id IS NOT NULL AND CASE WHEN cash.received>0 AND cash.received<COALESCE(su.settlement_amount,su.sale_amount) THEN 'legacy_partial' WHEN cash.received>0 AND cash.received>=COALESCE(su.settlement_amount,su.sale_amount) THEN 'company_received' WHEN c.id IS NOT NULL OR s.pending_collector_id IS NOT NULL THEN 'agent_pending' WHEN (NOT s.simple_ledger OR s.payment_verification='unknown') THEN 'unknown' ELSE 'unpaid' END=:paymentStatus"
      );
    }
    let base = `FROM stock_units u LEFT JOIN stock_products p ON p.id=u.product_id LEFT JOIN stock_locations l ON l.id=u.location_id
      LEFT JOIN stock_sale_units su ON su.stock_unit_id=u.id AND su.status='shipped'
      LEFT JOIN stock_locations wl ON wl.id=COALESCE(u.location_id,u.return_location_id,su.from_location_id) AND wl.kind='warehouse'
      LEFT JOIN stock_sale_lines sl ON sl.id=su.sale_line_id LEFT JOIN stock_sales s ON s.id=sl.sale_id AND s.status='shipped'
      LEFT JOIN stock_parties sp ON sp.id=s.salesperson_id
      LEFT JOIN stock_collections c ON c.sale_id=s.id AND c.status='posted'
      LEFT JOIN LATERAL (SELECT COALESCE(SUM(a.amount),0) received FROM stock_receipt_allocations a WHERE a.sale_unit_id=su.id AND a.status='active') cash ON true
      WHERE ${LEDGER_SQL}${filters.length ? ' AND ' + filters.join(' AND ') : ''}`;
    if (searchFilter) {
      // 加密备注只能在服务端匹配；先限定台账及其他筛选，再按主键分批读取密文。
      const noteIds = [];
      let afterId = null;
      let hasMore = true;
      while (hasMore) {
        const [candidates] = await db.sequelize.query(
          `SELECT DISTINCT u.id, u.notes_ciphertext AS "notesCiphertext" ${base}
           AND u.notes_ciphertext IS NOT NULL ${afterId ? 'AND u.id > :afterId' : ''}
           ORDER BY u.id LIMIT 500`,
          { replacements: { ...replacements, afterId }, transaction: ctx.transaction }
        );
        for (const candidate of candidates) {
          if ((decrypt(candidate.notesCiphertext) || '').toLowerCase().includes(searchText))
            noteIds.push(candidate.id);
        }
        hasMore = candidates.length === 500;
        afterId = candidates[candidates.length - 1]?.id;
      }
      replacements.noteIds = noteIds;
      base += ` AND (${searchFilter}${noteIds.length ? ' OR u.id IN (:noteIds)' : ''})`;
    }
    if (statistics) {
      const [items] = await db.sequelize.query(
        `SELECT COALESCE(p.model_name,'机型待补') AS "modelName",p.storage_gb AS "storageGb",p.color_name AS "colorName",COUNT(DISTINCT u.id)::integer AS count
        ${base} GROUP BY p.model_name,p.storage_gb,p.color_name ORDER BY p.model_name NULLS LAST,p.storage_gb,p.color_name`,
        { replacements, transaction: ctx.transaction }
      );
      const models = new Map();
      for (const item of items)
        models.set(item.modelName, (models.get(item.modelName) || 0) + item.count);
      return {
        items,
        models: [...models].map(([modelName, count]) => ({ modelName, count })),
        total: items.reduce((n, item) => n + item.count, 0),
      };
    }
    const [counts] = await db.sequelize.query(
      `SELECT COUNT(*) FILTER(WHERE u.state='in_stock')::integer AS "inStock",COUNT(*) FILTER(WHERE u.state='sold')::integer AS sold,COUNT(*) FILTER(WHERE u.state='registered')::integer AS pending,COUNT(*) FILTER(WHERE u.state='returned')::integer AS returned ${base}`,
      { replacements, transaction: ctx.transaction }
    );
    const scope = view === 'all' ? '' : ` AND u.state='${view}'`;
    const [rows] = await db.sequelize.query(
      `SELECT u.id ${base}${scope} ORDER BY COALESCE(s.shipped_at,u.first_received_at,u.created_at) DESC,u.id DESC LIMIT :limit OFFSET :offset`,
      { replacements, transaction: ctx.transaction }
    );
    const countKey = new Map([
      ['registered', 'pending'],
      ['in_stock', 'inStock'],
      ['sold', 'sold'],
      ['returned', 'returned'],
    ]).get(view);
    return {
      items: await byIds(
        ctx,
        rows.map(row => row.id)
      ),
      total:
        view === 'all'
          ? Object.values(counts[0]).reduce((sum, n) => sum + n, 0)
          : counts[0][countKey],
      page,
      pageSize,
      counts: counts[0],
    };
  } catch (error) {
    logger.debug('简化台账分页失败', { code: error.code || error.name });
    throw error;
  }
}
module.exports = { catalog, list, detail, byIds, dispatchPreview };
