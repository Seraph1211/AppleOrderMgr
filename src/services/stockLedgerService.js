const { effectiveProducts } = require('./stockOrderProduct');
const { assertLifecycleWritable } = require('./stockLifecycleRules');
const { Op } = require('sequelize');
const { fixedCost, specification } = require('./stockFixedCatalog');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { encrypt } = require('../utils/fieldEncryption');
const { text, array, only, dateOnly, choice, digest } = require('../utils/stockRules');
const { cents } = require('../utils/stockMoney');
const { normalizeDeviceBarcodes } = require('./pickupDeviceRules');
const { scopeOrderWhere } = require('./orderAccessService');
const command = require('./stockCommandService');
const { activeRow, ensureUnit, bindSource } = require('./stockUnitService');
const { assertStockAvailable } = require('./stockSalesService');
const { assertFinanceConsistent } = require('./stockFinanceService');
const { requirePermissions, getRow, assertVersion, updateRow, recordEvent } = command;
const UNIT_FIELDS = [
  'serialNumber',
  'expectedVersion',
  'productId',
  'product',
  'warehouseId',
  'receivedOn',
  'orderNumber',
  'officialCostAmount',
  'costBasis',
  'acquiredOn',
  'extraExpenseAmount',
  'notes',
];
/** 结算为人工确认值，未知不自动推算；已含抽成和其他费用。 */
function settlement(value, saleAmount) {
  if (value == null || value === '') return null;
  if (cents(value) > cents(saleAmount, { positive: true }))
    throw ApiError.badRequest('结算金额不能超过售价');
  return value;
}
const PAYMENT_STATES = ['unpaid', 'agent_pending', 'company_received', 'unknown'];
const audit = ctx => ({ createdBy: ctx.user.id, updatedBy: ctx.user.id });
const options = ctx => ({ transaction: ctx.transaction });

/** 日期按北京时间零点保存，未知日期不替换为今天。 */
function day(value, label = '日期', optional = false) {
  if (optional && (value == null || value === '')) return null;
  try {
    return new Date(`${dateOnly(value)}T00:00:00+08:00`);
  } catch (_error) {
    throw ApiError.badRequest(`${label}无效`, undefined, 'DATE_INVALID');
  }
}
/** 将实际时间投影为北京时间日期。 */
function dateLabel(value) {
  return value
    ? new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10)
    : null;
}
function correction(ctx, reason) {
  requirePermissions(ctx, 'stock.correct');
  ctx.reason = text(reason, '更正原因', 500);
}
async function create(ctx, name, values, action) {
  try {
    const row = await db[name].create({ ...values, ...audit(ctx) }, options(ctx));
    await recordEvent(ctx, name, row, action);
    return row;
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
/** 表单中直接选已有规格或按可读名称新建，内部key不暴露给操作者。 */
async function resolveProduct(ctx, input) {
  try {
    if (input.productId && input.product) throw ApiError.badRequest('规格只能选择一种填写方式');
    if (input.productId) return await activeRow(ctx, 'StockProduct', input.productId);
    only(input.product, ['modelName', 'storageGb', 'colorName']);
    const modelName = text(input.product.modelName, '型号', 100);
    const colorName = text(input.product.colorName, '颜色', 64);
    const storageGb = input.product.storageGb;
    if (!Number.isInteger(storageGb) || storageGb <= 0 || storageGb > 100000)
      throw ApiError.badRequest('容量须为有效正整数');
    const match = await db.StockProduct.findOne({
      where: { modelName, colorName, storageGb, isActive: true },
      ...options(ctx),
    });
    if (match) return match;
    return await create(
      ctx,
      'StockProduct',
      {
        modelName,
        colorName,
        storageGb,
        modelKey: `ledger_${digest(modelName).slice(0, 40)}`,
        colorKey: `ledger_${digest(colorName).slice(0, 40)}`,
        isActive: true,
      },
      'ledger_product'
    );
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
async function resolvePerson(ctx, name, role, optional = false) {
  try {
    const normalized = text(name, role === 'handler' ? '出货人' : '销售人或代收人', 100, optional);
    if (!normalized) return null;
    let row = await db.StockParty.findOne({
      where: {
        name: normalized,
        isActive: true,
        partyType: { [Op.in]: ['internal_person', 'external_person'] },
      },
      ...options(ctx),
    });
    if (!row)
      row = await create(
        ctx,
        'StockParty',
        { name: normalized, partyType: 'external_person', roles: [role], isActive: true },
        'ledger_person'
      );
    else if (!row.roles.includes(role))
      await updateRow(ctx, row, { roles: [...row.roles, role] }, 'ledger_person_role');
    return row;
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
async function warehouse(ctx, id, optional = false) {
  try {
    if (!id && optional) return null;
    const row = await activeRow(ctx, 'StockLocation', id);
    if (row.kind !== 'warehouse') throw ApiError.badRequest('请选择自有仓库');
    return row;
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
async function assertBindingAccess(ctx, unit) {
  try {
    const binding = await db.PickupDevice.findOne({
      where: { stockUnitId: unit.id },
      ...options(ctx),
    });
    if (binding) {
      requirePermissions(ctx, 'stock.source.link', 'pickups.read', 'pickups.edit');
      if (
        !(await db.Order.findOne({
          where: scopeOrderWhere(ctx.user, { id: binding.orderId }),
          ...options(ctx),
        }))
      )
        throw ApiError.notFound('订单不存在或不可访问');
    }
    return binding;
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
async function setOrderNumber(ctx, unit, value) {
  try {
    requirePermissions(ctx, 'stock.source.link', 'orders.read');
    const number = text(value, '订单号', 100, true);
    const binding = await assertBindingAccess(ctx, unit);
    let order = null;
    if (number)
      order = await db.Order.findOne({
        where: scopeOrderWhere(ctx.user, { orderNumber: number }),
        ...options(ctx),
      });
    const shouldBind =
      binding ||
      (order && ctx.permissions.has('pickups.read') && ctx.permissions.has('pickups.edit'));
    if (shouldBind) await bindSource(ctx, unit, order?.id || null, binding?.id || null);
    await updateRow(
      ctx,
      unit,
      { orderNumberText: shouldBind && order ? null : number },
      'ledger_order'
    );
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
function supplementary(ctx, item, unit) {
  const values = {};
  if (item.acquiredOn !== undefined) {
    requirePermissions(ctx, 'stock.cost.edit');
    values.acquiredOn = item.acquiredOn ? dateOnly(item.acquiredOn) : null;
  }
  if (item.officialCostAmount !== undefined) {
    requirePermissions(ctx, 'stock.cost.edit');
    const amount = item.officialCostAmount;
    if (amount != null && amount !== '') cents(amount, { positive: true });
    Object.assign(values, {
      officialCostAmount: amount || null,
      costStatus: amount ? 'confirmed' : 'pending',
      costSource: amount ? 'manual' : null,
      priceId: null,
      costBasisCiphertext: encrypt(text(item.costBasis, '成本依据', 2000, true)),
    });
  }
  if (item.extraExpenseAmount !== undefined) {
    requirePermissions(ctx, 'stock.expenses.edit');
    const amount = item.extraExpenseAmount;
    if (amount != null && amount !== '') cents(amount);
    values.extraExpenseAmount = amount || null;
  }
  if (item.notes !== undefined)
    values.notesCiphertext = encrypt(text(item.notes, '备注', 2000, true));
  if (
    unit?.costSource === 'catalog' &&
    values.acquiredOn !== undefined &&
    values.acquiredOn !== unit.acquiredOn &&
    item.officialCostAmount === undefined
  )
    throw ApiError.badRequest('更改拿货日期时请重新核定官网成本');
  return values;
}
async function stockAvailable(ctx, unit) {
  try {
    assertLifecycleWritable(unit);
    if (unit.state !== 'in_stock')
      throw ApiError.conflict(
        `设备 ${unit.serialNumber} 已不在库，请刷新`,
        { unitId: unit.id },
        'UNIT_STATE_CONFLICT'
      );
    await warehouse(ctx, unit.locationId);
    if (
      await db.StockSaleUnit.count({
        where: { stockUnitId: unit.id, status: 'picked' },
        ...options(ctx),
      })
    )
      throw ApiError.conflict(
        '设备已有旧销售占用，请先处理旧记录',
        undefined,
        'LEGACY_LEDGER_CONFLICT'
      );
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
/** 入库复用身份时保持既有订单；更换来源须走显式更正流程。 */
async function receiveOrderNeedsLink(ctx, current, value) {
  try {
    const number = text(value, '订单号', 100, true);
    if (!number) return false;
    requirePermissions(ctx, 'stock.source.link', 'orders.read');
    if (!current) return true;
    const binding = await db.PickupDevice.findOne({
      where: { stockUnitId: current.id },
      attributes: ['orderId'],
      ...options(ctx),
    });
    if (!binding && !current.orderNumberText) return true;
    const order = binding
      ? await db.Order.findOne({
        where: scopeOrderWhere(ctx.user, { id: binding.orderId }),
        attributes: ['orderNumber'],
        ...options(ctx),
      })
      : null;
    if (binding && !order) throw ApiError.notFound('订单不存在或无权访问');
    const existing = binding ? order.orderNumber : current.orderNumberText;
    if (number !== existing)
      throw ApiError.conflict('该设备已有订单关联，请核对原记录，不可在入库时覆盖');
    return false;
  } catch (error) {
    logger.debug('入库订单核对失败', { code: error.code || error.name });
    throw error;
  }
}
function assertReceiveVersion(current, item) {
  if (!Object.prototype.hasOwnProperty.call(item, 'expectedVersion')) return;
  const version = item.expectedVersion;
  if (version !== null && (!Number.isInteger(version) || version < 0))
    throw ApiError.badRequest('设备版本无效');
  if ((current && version === null) || (!current && version !== null))
    throw ApiError.conflict('设备身份已变化，请重新核对', undefined, 'VERSION_CONFLICT');
  if (current) assertVersion(current, version);
}
async function registeredUnit(ctx, item, history) {
  try {
    only(item, [...UNIT_FIELDS, ...(history ? ['saleAmount', 'settlementAmount'] : [])]);
    if (
      item.officialCostAmount !== undefined ||
      item.acquiredOn !== undefined ||
      item.costBasis !== undefined
    )
      requirePermissions(ctx, 'stock.cost.edit');
    const serialNumber = normalizeDeviceBarcodes({ serialBarcode: item.serialNumber }).serialNumber;
    const current = await db.StockUnit.findOne({ where: { serialNumber }, ...options(ctx) });
    assertReceiveVersion(current, item);
    assertLifecycleWritable(current);
    if (current && current.state !== 'registered')
      throw ApiError.conflict(
        '该 SN 已有记录，请打开原记录操作',
        { unitId: current.id, existingUnitId: current.id },
        'SN_EXISTS'
      );
    const product = await resolveProduct(ctx, item);
    const existingProductId =
      current?.productId ||
      (current ? (await effectiveProducts(ctx, [current.id])).get(current.id)?.id : null);
    if (existingProductId && existingProductId !== product.id)
      throw ApiError.conflict('已有取货身份的规格不同，请先核对更正');
    const needsOrderLink = await receiveOrderNeedsLink(ctx, current, item.orderNumber);
    if (
      current?.costStatus === 'confirmed' &&
      ((item.officialCostAmount && item.officialCostAmount !== current.officialCostAmount) ||
        (item.acquiredOn && item.acquiredOn !== current.acquiredOn))
    )
      throw ApiError.conflict('已有核定成本不能在登记时覆盖，请先更正');
    const supplements = { ...item };
    if (current?.costStatus === 'confirmed') {
      delete supplements.officialCostAmount;
      delete supplements.acquiredOn;
    }
    const unit = current || (await ensureUnit(ctx, serialNumber, history ? 'history' : 'current'));
    const receivedAt = day(item.receivedOn, '入库日期', history);
    const location = await warehouse(ctx, item.warehouseId, history);
    await updateRow(
      ctx,
      unit,
      {
        productId: product.id,
        firstReceivedAt: receivedAt,
        ...(unit.costStatus !== 'confirmed' && supplements.officialCostAmount === undefined
          ? await fixedCost(db, product, ctx.transaction)
          : {}),
        ...supplementary(ctx, supplements, unit),
        ...(history ? {} : { state: 'in_stock', locationId: location.id }),
      },
      history ? 'ledger_history_identity' : 'ledger_receive'
    );
    if (needsOrderLink) await setOrderNumber(ctx, unit, item.orderNumber);
    return { unit, product, fromLocationId: location?.id || null };
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
/** 批量直接入库；旧取货身份复用，重复实物整批拒绝。 */
async function receiveUnits(ctx, input) {
  try {
    requirePermissions(ctx, 'stock.receive');
    const entries = array(input.units);
    const serials = entries.map(
      item => normalizeDeviceBarcodes({ serialBarcode: item.serialNumber }).serialNumber
    );
    if (new Set(serials).size !== serials.length)
      throw ApiError.conflict('本次登记存在重复 SN，请检查列表', undefined, 'SN_EXISTS');
    const ids = [];
    for (const [index, item] of entries.entries()) {
      try {
        ids.push((await registeredUnit(ctx, item, false)).unit.id);
      } catch (error) {
        if (error instanceof ApiError) error.details = { ...error.details, row: index + 1 };
        throw error;
      }
    }
    return { ledgerUnitIds: ids };
  } catch (error) {
    logger.debug('简化入库失败', { code: error.code || error.name });
    throw error;
  }
}
async function nextSaleNo(ctx) {
  try {
    const [rows] = await db.sequelize.query(
      "SELECT nextval('stock_sale_number_seq') AS n",
      options(ctx)
    );
    return `S${dateLabel(new Date()).replace(/-/g, '')}-${String(rows[0].n).padStart(6, '0')}`;
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
/** 读取资金事实，旧多台、部分到账及共享分配不允许单台重写。 */
async function saleFacts(ctx, unit, requireSimple = true) {
  try {
    if (unit.state !== 'sold') throw ApiError.conflict('仅已售设备可更新销售与货款');
    const saleUnit = await db.StockSaleUnit.findOne({
      where: { stockUnitId: unit.id, status: 'shipped' },
      ...options(ctx),
    });
    if (!saleUnit) throw ApiError.conflict('销售事实缺失，请核对原记录');
    const line = await getRow('StockSaleLine', saleUnit.saleLineId, ctx);
    const sale = await getRow('StockSale', line.saleId, ctx);
    if (sale.channel !== 'local' || sale.status !== 'shipped')
      throw ApiError.conflict('该设备不属于库存管理销售');
    const lines = await db.StockSaleLine.findAll({ where: { saleId: sale.id }, ...options(ctx) });
    const units = await db.StockSaleUnit.findAll({
      where: { saleLineId: lines.map(row => row.id), status: 'shipped' },
      ...options(ctx),
    });
    const collections = await db.StockCollection.findAll({
      where: { saleId: sale.id, status: 'posted' },
      ...options(ctx),
    });
    const allocations = await db.StockReceiptAllocation.findAll({
      where: { collectionId: collections.map(row => row.id), status: 'active' },
      ...options(ctx),
    });
    const receipts = await db.StockReceipt.findAll({
      where: {
        [Op.or]: [
          { id: allocations.map(row => row.receiptId) },
          { collectionId: collections.map(row => row.id) },
        ],
        status: 'posted',
      },
      ...options(ctx),
    });
    let compatible = units.length === 1 && collections.length <= 1;
    if (
      collections.length === 1 &&
      collections[0].amount !== (saleUnit.settlementAmount ?? saleUnit.saleAmount)
    )
      compatible = false;
    const allocated = allocations
      .filter(row => row.saleUnitId === saleUnit.id)
      .reduce((sum, row) => sum + cents(row.amount), 0n);
    if (allocated !== 0n && allocated !== cents(saleUnit.settlementAmount ?? saleUnit.saleAmount))
      compatible = false;
    if (receipts.length > 1 || allocations.some(row => row.saleUnitId !== saleUnit.id))
      compatible = false;
    for (const receipt of receipts) {
      const related = await db.StockReceiptAllocation.findAll({
        where: { receiptId: receipt.id, status: 'active' },
        ...options(ctx),
      });
      if (
        related.length !== 1 ||
        related[0].saleUnitId !== saleUnit.id ||
        receipt.amount !== (saleUnit.settlementAmount ?? saleUnit.saleAmount) ||
        related[0].amount !== receipt.amount
      )
        compatible = false;
    }
    if (requireSimple && !compatible)
      throw ApiError.conflict(
        '旧记录包含多台销售、部分到账或共享分配，不能用单台全额操作覆盖',
        undefined,
        'LEGACY_LEDGER_CONFLICT'
      );
    const collection = collections[0] || null;
    const receipt = receipts[0] || null;
    let status =
      !sale.simpleLedger || sale.paymentVerification === 'unknown' ? 'unknown' : 'unpaid';
    if (collection || sale.pendingCollectorId) status = 'agent_pending';
    if (allocated > 0n && allocated >= cents(saleUnit.settlementAmount ?? saleUnit.saleAmount))
      status = 'company_received';
    else if (allocated > 0n) status = 'legacy_partial';
    return {
      sale,
      saleUnit,
      line,
      collections,
      allocations,
      receipts,
      collection,
      receipt,
      status,
      compatible,
    };
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
async function reverseMoney(ctx, facts) {
  try {
    if (facts.collections.length || facts.sale.pendingCollectorId)
      requirePermissions(ctx, 'stock.collections.edit');
    if (facts.receipts.length || facts.allocations.length)
      requirePermissions(ctx, 'stock.receipts.edit');
    for (const row of facts.allocations)
      await updateRow(ctx, row, { status: 'reversed' }, 'ledger_money_reverse');
    for (const row of facts.receipts)
      await updateRow(ctx, row, { status: 'voided' }, 'ledger_money_reverse');
    for (const row of facts.collections)
      await updateRow(ctx, row, { status: 'voided' }, 'ledger_money_reverse');
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
async function applyPayment(ctx, unit, facts, payment, reason, initial = false) {
  try {
    only(payment, ['status', 'collectorName', 'collectedOn', 'receivedOn']);
    const status = choice(payment.status, PAYMENT_STATES, '货款状态');
    if (!initial || !['unpaid', 'unknown'].includes(status))
      requirePermissions(ctx, 'stock.collections.edit');
    if (status === 'unknown' && !facts.sale.isHistorical)
      throw ApiError.badRequest('待核实仅用于历史销售');
    if (status === 'company_received') requirePermissions(ctx, 'stock.receipts.edit');
    if (status === 'company_received' && facts.saleUnit.settlementAmount == null)
      throw ApiError.badRequest('请先填写结算金额，再登记公司已到账');
    const pendingAmount =
      status === 'agent_pending' && facts.saleUnit.settlementAmount == null && !facts.collection;
    if (!['unpaid', 'unknown'].includes(status) && !pendingAmount)
      cents(facts.saleUnit.settlementAmount ?? facts.saleUnit.saleAmount, { positive: true });
    const previous = facts.status;
    const forward = {
      unknown: ['unpaid', 'agent_pending', 'company_received'],
      unpaid: ['agent_pending', 'company_received'],
      ['agent_pending']: ['company_received'],
      ['company_received']: [],
    };
    const previousCollectorId = facts.collection?.collectorId || facts.sale.pendingCollectorId;
    const previousCollectedAt = facts.collection?.receivedAt || facts.sale.pendingCollectedAt;
    const oldCollector = previousCollectorId
      ? await getRow('StockParty', previousCollectorId, ctx)
      : null;
    const seller = facts.sale.salespersonId
      ? await getRow('StockParty', facts.sale.salespersonId, ctx)
      : null;
    const collectorName =
      payment.collectorName !== undefined ? payment.collectorName : oldCollector?.name;
    const agent =
      status === 'agent_pending' || (status === 'company_received' && Boolean(collectorName));
    const collectedOn =
      payment.collectedOn !== undefined ? payment.collectedOn : dateLabel(previousCollectedAt);
    const receivedOn =
      payment.receivedOn !== undefined ? payment.receivedOn : dateLabel(facts.receipt?.receivedAt);
    const effectiveCollector = agent
      ? await resolvePerson(ctx, collectorName || seller?.name, 'salesperson')
      : null;
    const collectionAt = day(
      collectedOn || (status === 'company_received' && !agent ? receivedOn : null),
      '收款日期',
      true
    );
    const receiptAt =
      status === 'company_received'
        ? day(receivedOn, '公司到账日期', facts.sale.isHistorical)
        : null;
    if (receiptAt && collectionAt && +receiptAt < +collectionAt)
      throw ApiError.badRequest('公司到账不能早于代收日期');
    if (
      ['unpaid', 'unknown'].includes(status) &&
      (payment.collectorName || payment.collectedOn || payment.receivedOn)
    )
      throw ApiError.badRequest('未收款或待核实不能同时填写收款事实');
    if (status === 'agent_pending' && payment.receivedOn)
      throw ApiError.badRequest('待转回不能填写公司到账日期');
    const same =
      status === previous &&
      (effectiveCollector?.id || null) === (previousCollectorId || null) &&
      dateLabel(collectionAt) === dateLabel(previousCollectedAt) &&
      dateLabel(receiptAt) === dateLabel(facts.receipt?.receivedAt) &&
      Boolean(facts.sale.pendingCollectorId) === pendingAmount &&
      (!facts.collection ||
        facts.collection.amount === (facts.saleUnit.settlementAmount ?? facts.saleUnit.saleAmount));
    const changesCollection =
      previousCollectorId &&
      ((effectiveCollector?.id || null) !== previousCollectorId ||
        dateLabel(collectionAt) !== dateLabel(previousCollectedAt));
    if (!initial && !same && (changesCollection || !(forward[previous] || []).includes(status)))
      correction(ctx, reason);
    if (same && !initial) return;
    await reverseMoney(ctx, facts);
    if (!['unpaid', 'unknown'].includes(status) && !pendingAmount) {
      const collection = await create(
        ctx,
        'StockCollection',
        {
          saleId: facts.sale.id,
          destination: agent ? 'agent' : 'company',
          collectorId: effectiveCollector?.id || null,
          amount: facts.saleUnit.settlementAmount ?? facts.saleUnit.saleAmount,
          receivedAt: collectionAt,
          status: 'posted',
        },
        'ledger_collection'
      );
      if (status === 'company_received') {
        const receipt = await create(
          ctx,
          'StockReceipt',
          {
            source: agent ? 'agent_transfer' : 'direct_customer',
            payerId: effectiveCollector?.id || null,
            collectionId: agent ? null : collection.id,
            amount: facts.saleUnit.settlementAmount ?? facts.saleUnit.saleAmount,
            receivedAt: receiptAt,
            status: 'posted',
          },
          'ledger_receipt'
        );
        await create(
          ctx,
          'StockReceiptAllocation',
          {
            receiptId: receipt.id,
            collectionId: collection.id,
            saleUnitId: facts.saleUnit.id,
            amount: facts.saleUnit.settlementAmount ?? facts.saleUnit.saleAmount,
            status: 'active',
          },
          'ledger_receipt_allocation'
        );
      }
    }
    await updateRow(
      ctx,
      facts.sale,
      {
        paymentVerification: status === 'unknown' ? 'unknown' : 'known',
        simpleLedger: true,
        pendingCollectorId: pendingAmount ? effectiveCollector.id : null,
        pendingCollectedAt: pendingAmount ? collectionAt : null,
      },
      'ledger_payment'
    );
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
async function applyExpense(ctx, unit, facts) {
  try {
    const existing = await db.StockExpense.findAll({
      where: { saleId: facts.sale.id, status: 'active' },
      ...options(ctx),
    });
    if (unit.extraExpenseAmount === null && !existing.length) return;
    if (existing.length) requirePermissions(ctx, 'stock.expenses.edit');
    for (const row of existing)
      await updateRow(ctx, row, { status: 'voided' }, 'ledger_expense_replace');
    if (unit.extraExpenseAmount && cents(unit.extraExpenseAmount) > 0n) {
      const expense = await create(
        ctx,
        'StockExpense',
        {
          saleId: facts.sale.id,
          category: 'other',
          scope: 'selected_units',
          amount: unit.extraExpenseAmount,
          occurredAt: facts.sale.shippedAt,
          status: 'active',
        },
        'ledger_expense'
      );
      await create(
        ctx,
        'StockExpenseAllocation',
        {
          expenseId: expense.id,
          expenseVersion: expense.version,
          saleUnitId: facts.saleUnit.id,
          amount: unit.extraExpenseAmount,
        },
        'ledger_expense_allocation'
      );
    }
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
async function createSale(ctx, prepared, input, item, historical) {
  try {
    const { unit, product, fromLocationId } = prepared;
    const soldAt = day(input.soldOn, '销售日期');
    if (unit.firstReceivedAt && dateLabel(unit.firstReceivedAt) > input.soldOn)
      throw ApiError.badRequest('销售日期不能早于入库日期');
    cents(item.saleAmount, { positive: true });
    const seller = await resolvePerson(ctx, input.salespersonName, 'salesperson', historical);
    const handler = await resolvePerson(ctx, input.handlerName, 'handler', historical);
    const sale = await create(
      ctx,
      'StockSale',
      {
        saleNo: await nextSaleNo(ctx),
        channel: 'local',
        status: 'shipped',
        salespersonId: seller?.id || null,
        handlerId: handler?.id || null,
        shippedAt: soldAt,
        isHistorical: historical,
        simpleLedger: true,
        paymentVerification: 'known',
        notesCiphertext: encrypt(text(input.notes, '备注', 2000, true)),
      },
      'ledger_sale'
    );
    const line = await create(
      ctx,
      'StockSaleLine',
      { saleId: sale.id, productId: product.id, quantity: 1, quotedUnitAmount: item.saleAmount },
      'ledger_sale_line'
    );
    const saleUnit = await create(
      ctx,
      'StockSaleUnit',
      {
        saleLineId: line.id,
        stockUnitId: unit.id,
        fromLocationId,
        status: 'shipped',
        saleAmount: item.saleAmount,
        settlementAmount: settlement(item.settlementAmount, item.saleAmount),
        costAmountSnapshot: unit.officialCostAmount,
        productSnapshot: product.toJSON(),
      },
      'ledger_sale_unit'
    );
    const soldValues = { state: 'sold', locationId: null };
    if (input.notes != null && String(input.notes).trim())
      soldValues.notesCiphertext = encrypt(text(input.notes, '备注', 2000));
    await updateRow(ctx, unit, soldValues, 'ledger_sold');
    const facts = {
      sale,
      saleUnit,
      line,
      collections: [],
      allocations: [],
      receipts: [],
      collection: null,
      receipt: null,
      status: 'unpaid',
      compatible: true,
    };
    await applyPayment(ctx, unit, facts, input.payment, null, true);
    await applyExpense(ctx, unit, facts);
    return unit.id;
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
/** 直接跨仓批量售出；不生成接单、预占和挑货中间步骤。 */
async function sellUnits(ctx, input) {
  try {
    requirePermissions(ctx, 'stock.sales.edit', 'stock.sales.ship');
    const ids = [];
    for (const item of array(input.units)) {
      only(item, ['id', 'expectedVersion', 'saleAmount', 'settlementAmount', 'extraExpenseAmount']);
      const unit = await getRow('StockUnit', item.id, ctx);
      assertVersion(unit, item.expectedVersion);
      await stockAvailable(ctx, unit);
      if (ids.includes(unit.id)) throw ApiError.badRequest('不能重复选择同一台设备');
      if (item.extraExpenseAmount !== undefined)
        await updateRow(
          ctx,
          unit,
          supplementary(ctx, { extraExpenseAmount: item.extraExpenseAmount }),
          'ledger_expense_input'
        );
      const product = await activeRow(ctx, 'StockProduct', unit.productId);
      ids.push(
        await createSale(
          ctx,
          { unit, product, fromLocationId: unit.locationId },
          input,
          item,
          false
        )
      );
    }
    await assertStockAvailable(ctx);
    await assertFinanceConsistent(ctx);
    return { ledgerUnitIds: ids };
  } catch (error) {
    logger.debug('简化售出失败', { code: error.code || error.name });
    throw error;
  }
}
/** 单台出库；在一个幂等事务中核验预览、补入库、核定成本并售出。 */
async function dispatchUnit(ctx, input) {
  try {
    requirePermissions(ctx, 'stock.read', 'stock.sales.edit', 'stock.sales.ship');
    const item = input.unit;
    only(item, [
      'serialNumber',
      'id',
      'expectedVersion',
      'needsReceive',
      'productId',
      'warehouseId',
      'receivedOn',
      'officialCostAmount',
      'extraExpenseAmount',
      'saleAmount',
      'settlementAmount',
    ]);
    if (typeof item.needsReceive !== 'boolean') throw ApiError.badRequest('请先查询并核对设备');
    const serialNumber = normalizeDeviceBarcodes({ serialBarcode: item.serialNumber }).serialNumber;
    let unit = await db.StockUnit.findOne({ where: { serialNumber }, ...options(ctx) });
    if ((unit?.id || null) !== (item.id || null))
      throw ApiError.conflict('设备身份已变化，请重新查询核对', undefined, 'VERSION_CONFLICT');
    if (unit) assertVersion(unit, item.expectedVersion);
    const needsReceive = !unit || unit.state === 'registered';
    if (needsReceive !== item.needsReceive)
      throw ApiError.conflict('设备入库状态已变化，请重新查询核对', undefined, 'VERSION_CONFLICT');
    const product = await activeRow(ctx, 'StockProduct', item.productId);
    if (!specification(product))
      throw ApiError.badRequest('本期出库登记仅支持预置 iPhone 18 Pro Max 规格');
    if (unit?.productId && unit.productId !== product.id)
      throw ApiError.conflict('盒标规格与设备记录不一致，请核对后更正');
    if (needsReceive) {
      requirePermissions(ctx, 'stock.receive');
      const received = await registeredUnit(
        ctx,
        {
          serialNumber,
          productId: product.id,
          warehouseId: item.warehouseId,
          receivedOn: item.receivedOn,
          ...(item.officialCostAmount !== undefined && unit?.costStatus !== 'confirmed'
            ? { officialCostAmount: item.officialCostAmount }
            : {}),
        },
        false
      );
      unit = received.unit;
    } else if (item.warehouseId !== undefined || item.receivedOn !== undefined) {
      throw ApiError.badRequest('已有库存的仓库及入库日期请在资料编辑中更正');
    }
    await stockAvailable(ctx, unit);
    const supplements = {};
    if (item.officialCostAmount !== undefined) {
      cents(item.officialCostAmount, { positive: true });
      supplements.officialCostAmount = item.officialCostAmount;
    }
    if (item.extraExpenseAmount !== undefined)
      supplements.extraExpenseAmount = item.extraExpenseAmount;
    if (Object.keys(supplements).length)
      await updateRow(ctx, unit, supplementary(ctx, supplements, unit), 'ledger_dispatch_inputs');
    const id = await createSale(
      ctx,
      { unit, product, fromLocationId: unit.locationId },
      input,
      item,
      false
    );
    await assertStockAvailable(ctx);
    await assertFinanceConsistent(ctx);
    return { ledgerUnitIds: [id] };
  } catch (error) {
    logger.debug('单台出库登记失败', { code: error.code || error.name });
    throw error;
  }
}
/** 手工补录历史销售，不创建现货，也不受盘点切换时间前置阻碍。 */
async function importHistory(ctx, input) {
  try {
    requirePermissions(ctx, 'stock.import', 'stock.sales.edit', 'stock.sales.ship');
    const entries = array(input.units);
    const serials = entries.map(
      item => normalizeDeviceBarcodes({ serialBarcode: item.serialNumber }).serialNumber
    );
    if (new Set(serials).size !== serials.length)
      throw ApiError.conflict('本次补录存在重复 SN，请检查列表', undefined, 'SN_EXISTS');
    const ids = [];
    for (const [index, item] of entries.entries()) {
      try {
        const prepared = await registeredUnit(ctx, item, true);
        ids.push(await createSale(ctx, prepared, input, item, true));
      } catch (error) {
        if (error instanceof ApiError) error.details = { ...error.details, row: index + 1 };
        throw error;
      }
    }
    await assertFinanceConsistent(ctx);
    return { ledgerUnitIds: ids };
  } catch (error) {
    logger.debug('历史销售补录失败', { code: error.code || error.name });
    throw error;
  }
}
/** 更新单台或多台全额货款，以原资金事实为准并全量回滚失败批次。 */
async function setPayment(ctx, input) {
  try {
    const ids = [];
    for (const item of array(input.units)) {
      only(item, ['id', 'expectedVersion']);
      if (ids.includes(item.id)) throw ApiError.badRequest('不能重复选择同一台设备');
      const unit = await getRow('StockUnit', item.id, ctx);
      assertVersion(unit, item.expectedVersion);
      const facts = await saleFacts(ctx, unit);
      await applyPayment(ctx, unit, facts, input.payment, input.reason);
      await updateRow(ctx, unit, {}, 'ledger_payment');
      ids.push(unit.id);
    }
    await assertFinanceConsistent(ctx);
    return { ledgerUnitIds: ids };
  } catch (error) {
    logger.debug('简化货款更新失败', { code: error.code || error.name });
    throw error;
  }
}
async function editSale(ctx, unit, facts, input, reason) {
  try {
    only(input, [
      'saleAmount',
      'settlementAmount',
      'salespersonName',
      'handlerName',
      'soldOn',
      'payment',
    ]);
    if (!Object.keys(input).length) return;
    correction(ctx, reason);
    requirePermissions(ctx, 'stock.sales.edit', 'stock.sales.ship');
    const values = {};
    if (input.salespersonName !== undefined)
      values.salespersonId =
        (await resolvePerson(ctx, input.salespersonName, 'salesperson', facts.sale.isHistorical))
          ?.id || null;
    if (input.handlerName !== undefined)
      values.handlerId =
        (await resolvePerson(ctx, input.handlerName, 'handler', facts.sale.isHistorical))?.id ||
        null;
    if (input.soldOn !== undefined) {
      values.shippedAt = day(input.soldOn, '销售日期');
      if (unit.firstReceivedAt && input.soldOn < dateLabel(unit.firstReceivedAt))
        throw ApiError.badRequest('销售日期不能早于入库日期');
    }
    if (input.saleAmount !== undefined || input.settlementAmount !== undefined) {
      const saleAmount = input.saleAmount ?? facts.saleUnit.saleAmount;
      cents(saleAmount, { positive: true });
      if ((input.settlementAmount === null || input.settlementAmount === '') && facts.collection)
        throw ApiError.badRequest('已有货款记录时请填写明确的结算金额，不能清空');
      const settlementAmount = settlement(
        input.settlementAmount === undefined
          ? facts.saleUnit.settlementAmount
          : input.settlementAmount,
        saleAmount
      );
      await updateRow(
        ctx,
        facts.saleUnit,
        { saleAmount, settlementAmount },
        'ledger_price_correct'
      );
      await updateRow(ctx, facts.line, { quotedUnitAmount: saleAmount }, 'ledger_price_correct');
    }
    await updateRow(ctx, facts.sale, values, 'ledger_sale_correct');
    let payment = input.payment;
    if (
      !payment &&
      (facts.collection || facts.sale.pendingCollectorId) &&
      (input.saleAmount !== undefined ||
        input.settlementAmount !== undefined ||
        input.soldOn !== undefined)
    )
      payment = { status: facts.status };
    if (payment) await applyPayment(ctx, unit, facts, payment, reason);
  } catch (error) {
    logger.debug('简化库存处理未完成', { code: error.code || error.name });
    throw error;
  }
}
/** 编辑单台资料与销售事实，保留订单访问控制、成本快照和版本。 */
async function editUnit(ctx, id, input) {
  try {
    requirePermissions(ctx, 'stock.receive');
    const unit = await getRow('StockUnit', id, ctx);
    assertVersion(unit, input.expectedVersion);
    if (!['registered', 'in_stock', 'sold'].includes(unit.state))
      throw ApiError.conflict('该设备不适用简化台账编辑');
    if (input.serialNumber !== undefined || input.orderNumber !== undefined)
      assertLifecycleWritable(unit);
    const facts = unit.state === 'sold' ? await saleFacts(ctx, unit, false) : null;
    if (!facts && unit.state !== 'registered') await stockAvailable(ctx, unit);
    if (
      unit.state === 'registered' &&
      ['warehouseId', 'receivedOn', 'sale'].some(key => input[key] !== undefined)
    )
      throw ApiError.badRequest('未入库资料编辑不能设置仓库、入库日期或销售，请使用登记入库');
    if (
      facts &&
      !facts.compatible &&
      (input.sale ||
        input.product ||
        input.productId ||
        input.officialCostAmount !== undefined ||
        input.extraExpenseAmount !== undefined)
    )
      throw ApiError.conflict(
        '旧复杂销售不可通过单台更正覆盖',
        undefined,
        'LEGACY_LEDGER_CONFLICT'
      );
    const values = supplementary(ctx, input, unit);
    if (input.serialNumber !== undefined) {
      await assertBindingAccess(ctx, unit);
      values.serialNumber = normalizeDeviceBarcodes({
        serialBarcode: input.serialNumber,
      }).serialNumber;
    }
    if (input.productId || input.product) {
      const product = await resolveProduct(ctx, input);
      values.productId = product.id;
      if (
        product.id !== unit.productId &&
        unit.costStatus === 'confirmed' &&
        input.officialCostAmount === undefined
      )
        throw ApiError.badRequest('更改规格时请重新填写对应官网成本或标记待补');
      if (facts) {
        correction(ctx, input.reason);
        requirePermissions(ctx, 'stock.sales.ship');
        await updateRow(ctx, facts.line, { productId: product.id }, 'ledger_product_correct');
        await updateRow(
          ctx,
          facts.saleUnit,
          { productSnapshot: product.toJSON() },
          'ledger_product_correct'
        );
      }
    }
    if (input.warehouseId !== undefined) {
      const target = await warehouse(ctx, input.warehouseId, Boolean(facts?.sale.isHistorical));
      if (facts) {
        correction(ctx, input.reason);
        await updateRow(
          ctx,
          facts.saleUnit,
          { fromLocationId: target?.id || null },
          'ledger_source_warehouse_correct'
        );
      } else {
        requirePermissions(ctx, 'stock.transfer');
        values.locationId = target.id;
      }
    }
    if (input.receivedOn !== undefined) {
      values.firstReceivedAt = day(input.receivedOn, '入库日期', Boolean(facts?.sale.isHistorical));
      const soldOn = input.sale?.soldOn || dateLabel(facts?.sale.shippedAt);
      if (facts && values.firstReceivedAt && dateLabel(values.firstReceivedAt) > soldOn)
        throw ApiError.badRequest('入库日期不能晚于销售日期');
    }
    if (facts && input.officialCostAmount !== undefined) {
      correction(ctx, input.reason);
      await updateRow(
        ctx,
        facts.saleUnit,
        { costAmountSnapshot: values.officialCostAmount },
        'ledger_cost_correct'
      );
    }
    await updateRow(ctx, unit, values, 'ledger_edit');
    if (input.orderNumber !== undefined) await setOrderNumber(ctx, unit, input.orderNumber);
    if (input.sale !== undefined) {
      if (!facts) throw ApiError.badRequest('在库设备请使用登记售出');
      await editSale(ctx, unit, facts, input.sale, input.reason);
    }
    if (facts && input.extraExpenseAmount !== undefined) await applyExpense(ctx, unit, facts);
    await assertStockAvailable(ctx);
    await assertFinanceConsistent(ctx);
    return { ledgerUnitIds: [unit.id] };
  } catch (error) {
    logger.debug('简化资料更正失败', { code: error.code || error.name });
    throw error;
  }
}
/** 仅纠正实物仍在仓的误售，资金、费用和销售一起作废保留审计。 */
async function recoverUnit(ctx, id, input) {
  try {
    correction(ctx, input.reason);
    requirePermissions(ctx, 'stock.sales.ship', 'stock.receive');
    if (input.confirmInWarehouse !== true)
      throw ApiError.badRequest('请先确认实物仍在仓，真实退换货不适用');
    const unit = await getRow('StockUnit', id, ctx);
    assertVersion(unit, input.expectedVersion);
    const target = await warehouse(ctx, input.warehouseId);
    const receivedAt =
      input.receivedOn !== undefined ? day(input.receivedOn, '实际入库日期') : unit.firstReceivedAt;
    if (!receivedAt) throw ApiError.badRequest('恢复在库前请补充实际入库日期，不能自动填写为今天');
    const facts = await saleFacts(ctx, unit);
    await reverseMoney(ctx, facts);
    const expenses = await db.StockExpense.findAll({
      where: { saleId: facts.sale.id, status: 'active' },
      ...options(ctx),
    });
    if (expenses.length || unit.extraExpenseAmount != null)
      requirePermissions(ctx, 'stock.expenses.edit');
    for (const expense of expenses)
      await updateRow(ctx, expense, { status: 'voided' }, 'ledger_mistake_recover');
    await updateRow(ctx, facts.saleUnit, { status: 'voided' }, 'ledger_mistake_recover');
    await updateRow(
      ctx,
      facts.sale,
      { status: 'voided', pendingCollectorId: null, pendingCollectedAt: null },
      'ledger_mistake_recover'
    );
    await updateRow(
      ctx,
      unit,
      {
        state: 'in_stock',
        locationId: target.id,
        firstReceivedAt: receivedAt,
        extraExpenseAmount: null,
      },
      'ledger_mistake_recover'
    );
    await assertFinanceConsistent(ctx);
    return { ledgerUnitIds: [unit.id] };
  } catch (error) {
    logger.debug('误售恢复失败', { code: error.code || error.name });
    throw error;
  }
}
module.exports = {
  receiveUnits,
  sellUnits,
  dispatchUnit,
  importHistory,
  setPayment,
  editUnit,
  recoverUnit,
  day,
  dateLabel,
  saleFacts,
};
