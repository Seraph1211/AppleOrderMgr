const logger = require('../utils/logger');
const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { encrypt } = require('../utils/fieldEncryption');
const { cents, money, sumMoney } = require('../utils/stockMoney');
const { array, choice, instant, text, uuid } = require('../utils/stockRules');
const { activeRow } = require('./stockUnitService');
const {
  requirePermissions,
  getRow,
  assertVersion,
  recordEvent,
  updateRow,
} = require('./stockCommandService');
/** 一次读取销售有效实机，付款以实机售价为准。 */
async function soldUnits(ctx, saleId) {
  try {
    const lines = await db.StockSaleLine.findAll({
      where: { saleId },
      transaction: ctx.transaction,
    });
    return await db.StockSaleUnit.findAll({
      where: { saleLineId: { [Op.in]: lines.map(line => line.id) }, status: 'shipped' },
      transaction: ctx.transaction,
    });
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockFinanceService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 限制资金外部键，仅导入服务生成的摘要可传入。 */
function externalKey(ctx, value) {
  if (value == null) return null;
  if (!ctx.importing || typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw ApiError.badRequest('外部记录键只能由已核验导入生成');
  return value;
}
/** 登记全单客户付款；公司直收只形成一次到账。 */
async function createCollection(ctx, input) {
  try {
    requirePermissions(ctx, 'stock.collections.edit');
    const sale = await getRow('StockSale', input.saleId, ctx);
    if (sale.status !== 'shipped') throw ApiError.conflict('客户付款只能关联已出货销售');
    const destination = choice(input.destination, ['agent', 'company']);
    if (destination === 'company') requirePermissions(ctx, 'stock.receipts.edit');
    const collectorId =
      destination === 'agent' ? (await activeRow(ctx, 'StockParty', input.collectorId)).id : null;
    if (destination === 'company' && input.collectorId != null)
      throw ApiError.badRequest('公司直收不设置代收人');
    cents(input.amount, { positive: true });
    const units = await soldUnits(ctx, sale.id);
    if (input.amount !== sumMoney(units.map(unit => unit.saleAmount)))
      throw ApiError.badRequest('客户付款必须等于全单售价');
    if (
      await db.StockCollection.count({
        where: { saleId: sale.id, status: 'posted' },
        transaction: ctx.transaction,
      })
    )
      throw ApiError.conflict('本单已登记客户付款');
    const collection = await db.StockCollection.create(
      {
        saleId: sale.id,
        destination,
        collectorId,
        amount: input.amount,
        receivedAt: instant(input.receivedAt),
        externalRecordKey: externalKey(ctx, input.externalRecordKey),
        notesCiphertext: encrypt(text(input.notes, '备注', 2000, true)),
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      },
      { transaction: ctx.transaction }
    );
    await recordEvent(ctx, 'StockCollection', collection, 'collection');
    if (destination === 'company') await createDirectReceipt(ctx, collection, units);
    return { collectionId: collection.id, saleId: sale.id };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockFinanceService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 直收配套到账及全额关联，不能二次增加销售额。 */
async function createDirectReceipt(ctx, collection, units) {
  try {
    const receipt = await db.StockReceipt.create(
      {
        source: 'direct_customer',
        collectionId: collection.id,
        amount: collection.amount,
        receivedAt: collection.receivedAt,
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      },
      { transaction: ctx.transaction }
    );
    await recordEvent(ctx, 'StockReceipt', receipt, 'direct_receipt');
    await applyAllocations(
      ctx,
      receipt,
      units.map(unit => ({
        collectionId: collection.id,
        saleUnitId: unit.id,
        amount: unit.saleAmount,
      }))
    );
    return receipt;
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockFinanceService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 完整替换到账分配并反转旧明细，严格限制代收人和两侧余额。 */
async function applyAllocations(ctx, receipt, allocations) {
  try {
    if (receipt.status !== 'posted') throw ApiError.conflict('作废到账不能分配');
    const items = array(allocations || [], ctx.importing ? 500 : 100, true);
    const previous = await db.StockReceiptAllocation.findAll({
      where: { receiptId: receipt.id, status: 'active' },
      transaction: ctx.transaction,
    });
    for (const old of previous)
      await updateRow(ctx, old, { status: 'reversed' }, 'allocation_reverse');
    const seen = new Set();
    let total = 0n;
    for (const input of items) {
      uuid(input.saleUnitId);
      uuid(input.collectionId);
      const amount = cents(input.amount, { positive: true });
      total += amount;
      if (seen.has(input.saleUnitId)) throw ApiError.badRequest('一笔到账同一机器只能关联一次');
      seen.add(input.saleUnitId);
      const item = await getRow('StockSaleUnit', input.saleUnitId, ctx);
      const line = await getRow('StockSaleLine', item.saleLineId, ctx);
      const collection = await getRow('StockCollection', input.collectionId, ctx);
      if (
        item.status !== 'shipped' ||
        collection.status !== 'posted' ||
        line.saleId !== collection.saleId
      )
        throw ApiError.conflict('到账关联不属于有效销售付款');
      if (
        receipt.source === 'agent_transfer' &&
        (collection.destination !== 'agent' || collection.collectorId !== receipt.payerId)
      )
        throw ApiError.conflict('不能抵销其他代收人的货款', undefined, 'COLLECTOR_MISMATCH');
      if (
        receipt.source === 'direct_customer' &&
        (collection.destination !== 'company' || receipt.collectionId !== collection.id)
      )
        throw ApiError.conflict('公司直收关联不匹配');
      const others = await db.StockReceiptAllocation.findAll({
        where: { saleUnitId: item.id, status: 'active' },
        transaction: ctx.transaction,
      });
      if (
        amount + others.reduce((sum, row) => sum + cents(row.amount), 0n) >
        cents(item.saleAmount)
      )
        throw ApiError.conflict('该机器到账分配超额', undefined, 'RECEIPT_OVERALLOCATED');
      await db.StockReceiptAllocation.create(
        {
          receiptId: receipt.id,
          collectionId: collection.id,
          saleUnitId: item.id,
          amount: input.amount,
          createdBy: ctx.user.id,
          updatedBy: ctx.user.id,
        },
        { transaction: ctx.transaction }
      );
    }
    if (total > cents(receipt.amount))
      throw ApiError.conflict('分配超过实际到账金额', undefined, 'RECEIPT_OVERALLOCATED');
    return {
      allocatedAmount: money(total),
      unallocatedAmount: money(cents(receipt.amount) - total),
    };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockFinanceService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 代理转回可涵盖多单多台，费用另算。 */
async function createReceipt(ctx, input) {
  try {
    requirePermissions(ctx, 'stock.receipts.edit');
    if (input.source !== undefined && input.source !== 'agent_transfer')
      throw ApiError.badRequest('公司直收应从客户付款登记');
    await activeRow(ctx, 'StockParty', input.payerId);
    cents(input.amount, { positive: true });
    const receipt = await db.StockReceipt.create(
      {
        source: 'agent_transfer',
        payerId: input.payerId,
        amount: input.amount,
        receivedAt: instant(input.receivedAt),
        externalRecordKey: externalKey(ctx, input.externalRecordKey),
        notesCiphertext: encrypt(text(input.notes, '备注', 2000, true)),
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      },
      { transaction: ctx.transaction }
    );
    await applyAllocations(ctx, receipt, input.allocations);
    await recordEvent(ctx, 'StockReceipt', receipt, 'receipt');
    return { receiptId: receipt.id };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockFinanceService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 重关联现有到账，版本冲突时不反转旧账。 */
async function setAllocations(ctx, id, input) {
  try {
    const receipt = await getRow('StockReceipt', id, ctx);
    assertVersion(receipt, input.expectedVersion);
    if (receipt.source === 'direct_customer') throw ApiError.conflict('公司直收通过客户付款更正');
    await applyAllocations(ctx, receipt, input.allocations);
    await updateRow(ctx, receipt, {}, 'allocations');
    return { receiptId: id };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockFinanceService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 更正到账，保留历史分配。由认证预览命令调用。 */
async function correctReceipt(ctx, receipt, changes, allowDirect = false) {
  try {
    requirePermissions(ctx, 'stock.receipts.edit');
    if (receipt.source === 'direct_customer' && !allowDirect)
      throw ApiError.conflict('公司直收通过关联客户付款更正', undefined, 'CORRECTION_CONFLICT');
    if (receipt.status !== 'posted') throw ApiError.conflict('记录已作废');
    const values = {};
    if (changes.amount !== undefined) {
      cents(changes.amount, { positive: true });
      values.amount = changes.amount;
    }
    if (changes.receivedAt !== undefined) values.receivedAt = instant(changes.receivedAt);
    if (changes.payerId !== undefined) {
      await activeRow(ctx, 'StockParty', changes.payerId);
      values.payerId = changes.payerId;
    }
    const old = await db.StockReceiptAllocation.findAll({
      where: { receiptId: receipt.id, status: 'active' },
      transaction: ctx.transaction,
    });
    if (changes.void) {
      for (const allocation of old)
        await updateRow(ctx, allocation, { status: 'reversed' }, 'receipt_void');
      values.status = 'voided';
      await updateRow(ctx, receipt, values, 'receipt_correct');
    } else {
      await updateRow(ctx, receipt, values, 'receipt_correct');
      await applyAllocations(
        ctx,
        receipt,
        changes.allocations ??
          old.map(row => ({
            collectionId: row.collectionId,
            saleUnitId: row.saleUnitId,
            amount: row.amount,
          }))
      );
    }
    return receipt;
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockFinanceService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 更正全单付款，已转回关联必须一起处理，直收同步到账。 */
async function correctCollection(ctx, collection, changes) {
  try {
    requirePermissions(ctx, 'stock.collections.edit');
    if (collection.status !== 'posted') throw ApiError.conflict('付款已经作废');
    const direct = await db.StockReceipt.findOne({
      where: { collectionId: collection.id, source: 'direct_customer', status: 'posted' },
      transaction: ctx.transaction,
    });
    const destination = changes.destination ?? collection.destination;
    choice(destination, ['company', 'agent']);
    if (direct || destination === 'company') requirePermissions(ctx, 'stock.receipts.edit');
    // Company direct is rebuilt in the same transaction, preserving the old record.
    if (direct) await correctReceipt(ctx, direct, { void: true }, true);
    const values = {
      destination,
      collectorId: destination === 'agent' ? (changes.collectorId ?? collection.collectorId) : null,
    };
    if (destination === 'agent') await activeRow(ctx, 'StockParty', values.collectorId);
    if (changes.receivedAt !== undefined) values.receivedAt = instant(changes.receivedAt);
    if (changes.amount !== undefined) {
      cents(changes.amount, { positive: true });
      values.amount = changes.amount;
    }
    const units = await soldUnits(ctx, collection.saleId);
    if (
      !changes.void &&
      (values.amount ?? collection.amount) !== sumMoney(units.map(unit => unit.saleAmount))
    )
      throw ApiError.conflict('付款金额须与当前全单售价一致', undefined, 'CORRECTION_CONFLICT');
    // 先更新付款事实，再按新收款人重建相关到账；临时状态仅在同一事务内可见。
    await updateRow(
      ctx,
      collection,
      { ...values, ...(changes.void ? { status: 'voided' } : {}) },
      'collection_correct'
    );
    for (const item of changes.receiptChanges || []) {
      const receipt = await getRow('StockReceipt', item.id, ctx);
      assertVersion(receipt, item.expectedVersion);
      await correctReceipt(ctx, receipt, item);
    }
    const allocations = await db.StockReceiptAllocation.findAll({
      where: { collectionId: collection.id, status: 'active' },
      transaction: ctx.transaction,
    });
    if (changes.void && allocations.length)
      throw ApiError.conflict('请先提供完整到账解除安排', undefined, 'CORRECTION_CONFLICT');
    for (const allocation of allocations) {
      const receipt = await getRow('StockReceipt', allocation.receiptId, ctx);
      if (destination !== 'agent' || receipt.payerId !== collection.collectorId)
        throw ApiError.conflict('代收人变化与现有到账关联冲突', undefined, 'COLLECTOR_MISMATCH');
    }
    if (!changes.void && destination === 'company')
      await createDirectReceipt(ctx, collection, units);
    return collection;
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockFinanceService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 验证更正后的全局金融边界，任何冲突整笔回滚。 */
async function assertFinanceConsistent(ctx) {
  try {
    const [rows] = await db.sequelize.query(
      `SELECT 1 FROM stock_receipts r WHERE r.status='posted' AND (SELECT COALESCE(sum(a.amount),0) FROM stock_receipt_allocations a WHERE a.receipt_id=r.id AND a.status='active')>r.amount
      UNION ALL SELECT 1 FROM stock_sale_units u WHERE (SELECT COALESCE(sum(a.amount),0) FROM stock_receipt_allocations a WHERE a.sale_unit_id=u.id AND a.status='active')>COALESCE(u.settlement_amount,u.sale_amount,0)
      UNION ALL SELECT 1 FROM stock_collections c WHERE c.status='posted' AND c.amount<>(SELECT COALESCE(sum(COALESCE(u.settlement_amount,u.sale_amount)),0) FROM stock_sale_lines l JOIN stock_sale_units u ON u.sale_line_id=l.id AND u.status='shipped' WHERE l.sale_id=c.sale_id)
      UNION ALL SELECT 1 FROM stock_receipt_allocations a JOIN stock_collections c ON c.id=a.collection_id JOIN stock_receipts r ON r.id=a.receipt_id JOIN stock_sale_units u ON u.id=a.sale_unit_id WHERE a.status='active' AND (c.status<>'posted' OR r.status<>'posted' OR u.status<>'shipped' OR (r.source='agent_transfer' AND (c.destination<>'agent' OR c.collector_id<>r.payer_id))) LIMIT 1`,
      { transaction: ctx.transaction }
    );
    if (rows.length)
      throw ApiError.conflict('更正后款项不平，请补齐关联更正', undefined, 'CORRECTION_CONFLICT');
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockFinanceService',
      code: error.code || error.name,
    });
    throw error;
  }
}
module.exports = {
  soldUnits,
  createCollection,
  createReceipt,
  setAllocations,
  applyAllocations,
  correctCollection,
  correctReceipt,
  assertFinanceConsistent,
};
