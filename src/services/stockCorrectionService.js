const logger = require('../utils/logger');
const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { encrypt, decrypt } = require('../utils/fieldEncryption');
const { choice, only, text, digest, instant, array } = require('../utils/stockRules');
const { cents } = require('../utils/stockMoney');
const { normalizeDeviceBarcodes } = require('./pickupDeviceRules');
const {
  requirePermissions,
  createReadContext,
  getRow,
  assertVersion,
  updateRow,
} = require('./stockCommandService');
const { scopeOrderWhere } = require('./orderAccessService');
const { activeRow } = require('./stockUnitService');
const { assertStockAvailable, assertUnitTime } = require('./stockSalesService');
const {
  correctCollection,
  correctReceipt,
  assertFinanceConsistent,
  soldUnits,
} = require('./stockFinanceService');
const { allocateExpense } = require('./stockExpenseService');
const { projectEvent } = require('./stockProjectionService');
const TARGETS = {
  ['unit_identity']: ['StockUnit', 'stock.receive'],
  ['unit_location']: ['StockUnit', 'stock.transfer'],
  ['sale_fact']: ['StockSale', 'stock.sales.ship'],
  ['collection_fact']: ['StockCollection', 'stock.collections.edit'],
  ['receipt_fact']: ['StockReceipt', 'stock.receipts.edit'],
};
const FIELDS = {
  ['unit_identity']: ['serialNumber', 'productId'],
  ['unit_location']: ['locationId', 'state', 'occurredAt', 'transferResolution'],
  ['sale_fact']: [
    'shippedAt',
    'salespersonId',
    'handlerId',
    'unitPrices',
    'replacements',
    'void',
    'unitRestorations',
    'collectionChange',
    'receiptChanges',
  ],
  ['collection_fact']: [
    'amount',
    'receivedAt',
    'destination',
    'collectorId',
    'void',
    'receiptChanges',
  ],
  ['receipt_fact']: ['amount', 'receivedAt', 'payerId', 'void', 'allocations'],
};
function payload(input) {
  return {
    kind: input.kind,
    targetId: input.targetId,
    expectedVersion: input.expectedVersion,
    changes: input.changes,
    reason: input.reason,
  };
}
function validate(ctx, input) {
  choice(input.kind, Object.keys(TARGETS));
  requirePermissions(ctx, 'stock.correct', TARGETS[input.kind][1]);
  const reason = text(input.reason, '更正原因', 500);
  if (reason.length < 5) throw ApiError.badRequest('更正原因至少5字');
  only(input.changes, FIELDS[input.kind]);
  if (input.changes.receiptChanges !== undefined) array(input.changes.receiptChanges, 100, true);
  if (input.changes.void !== undefined && input.changes.void !== true)
    throw ApiError.badRequest('作废标记只能为true');
  if (!Object.keys(input.changes).length) throw ApiError.badRequest('没有更正内容');
  for (const value of [
    input.changes.collectionChange,
    ...(input.changes.receiptChanges || []),
  ].filter(Boolean))
    if (!Number.isInteger(value.expectedVersion)) throw ApiError.badRequest('关联更正须提供版本');
}
/** 读取目标及相关销售、实物、转运、资金版本，不写业务。 */
async function dependencies(ctx, input) {
  try {
    const model = TARGETS[input.kind][0];
    const row = await getRow(model, input.targetId, ctx);
    assertVersion(row, input.expectedVersion);
    const keys = new Map();
    const add = r => {
      if (r)
        keys.set(`${r.constructor.name}:${r.id}`, {
          model: r.constructor.name,
          id: r.id,
          version: r.version,
        });
    };
    add(row);
    const unitIds = new Set();
    const saleIds = new Set();
    const collectionIds = new Set();
    const receiptIds = new Set();
    if (model === 'StockUnit') unitIds.add(row.id);
    if (model === 'StockSale') saleIds.add(row.id);
    if (model === 'StockCollection') {
      collectionIds.add(row.id);
      saleIds.add(row.saleId);
    }
    if (model === 'StockReceipt') receiptIds.add(row.id);
    for (const replacement of input.changes.replacements || []) unitIds.add(replacement.newUnitId);
    for (const r of input.changes.receiptChanges || []) receiptIds.add(r.id);
    if (input.changes.collectionChange) collectionIds.add(input.changes.collectionChange.id);
    const allUnits = await db.StockSaleUnit.findAll({ transaction: ctx.transaction });
    const lines = await db.StockSaleLine.findAll({ transaction: ctx.transaction });
    for (const su of allUnits)
      if (unitIds.has(su.stockUnitId)) saleIds.add(lines.find(l => l.id === su.saleLineId)?.saleId);
    for (const saleId of saleIds) {
      if (!saleId) continue;
      add(await getRow('StockSale', saleId, ctx));
      for (const line of lines.filter(l => l.saleId === saleId)) {
        add(line);
        for (const su of allUnits.filter(u => u.saleLineId === line.id)) {
          add(su);
          unitIds.add(su.stockUnitId);
        }
      }
    }
    for (const id of unitIds) {
      add(await getRow('StockUnit', id, ctx));
      const transfers = await db.StockTransferUnit.findAll({
        where: { stockUnitId: id },
        transaction: ctx.transaction,
      });
      for (const t of transfers) {
        add(t);
        add(await getRow('StockTransfer', t.transferId, ctx));
      }
    }
    const collections = await db.StockCollection.findAll({ transaction: ctx.transaction });
    for (const c of collections)
      if (saleIds.has(c.saleId) || collectionIds.has(c.id)) {
        add(c);
        collectionIds.add(c.id);
      }
    const allocations = await db.StockReceiptAllocation.findAll({
      where: { status: 'active' },
      transaction: ctx.transaction,
    });
    for (const a of allocations)
      if (collectionIds.has(a.collectionId) || receiptIds.has(a.receiptId)) {
        add(a);
        receiptIds.add(a.receiptId);
      }
    for (const id of receiptIds) {
      const r = await getRow('StockReceipt', id, ctx);
      add(r);
      if (r.collectionId) {
        const c = await getRow('StockCollection', r.collectionId, ctx);
        add(c);
      }
    }
    const expenses = await db.StockExpense.findAll({
      where: { saleId: { [Op.in]: [...saleIds].filter(Boolean) } },
      transaction: ctx.transaction,
    });
    expenses.forEach(add);
    return {
      row,
      versions: [...keys.values()].sort((a, b) =>
        `${a.model}:${a.id}`.localeCompare(`${b.model}:${b.id}`)
      ),
    };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCorrectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 服务端认证加密的只读预览，绑定操作者/请求/期限/所有依赖版本。 */
async function previewCorrection(user, input) {
  try {
    return await db.sequelize.transaction(
      { isolationLevel: 'REPEATABLE READ' },
      async transaction => {
        const ctx = await createReadContext(user, transaction);
        validate(ctx, input);
        const { row, versions } = await dependencies(ctx, input);
        const visibleVersions = versions.filter(v => {
          const permission = {
            StockSale: 'stock.sales.read',
            StockSaleLine: 'stock.sales.read',
            StockSaleUnit: 'stock.sales.read',
            StockExpense: 'stock.expenses.read',
            StockCollection: 'stock.collections.read',
            StockReceipt: 'stock.receipts.read',
            StockReceiptAllocation: 'stock.receipts.read',
          }[v.model];
          return !permission || ctx.permissions.has(permission);
        });
        const expiresAt = Date.now() + 10 * 60 * 1000;
        const token = encrypt(
          JSON.stringify({
            purpose: 'stock_correction',
            userId: user.id,
            requestHash: digest(payload(input)),
            targetVersions: versions,
            expiresAt,
          })
        );
        const event = projectEvent(ctx, {
          entityType: TARGETS[input.kind][0],
          changesCiphertext: { before: row.toJSON(), after: input.changes, reason: input.reason },
        });
        return {
          previewToken: token,
          expiresAt: new Date(expiresAt).toISOString(),
          targetVersions: visibleVersions,
          changes: event?.changes || {},
          effects: visibleVersions.map(v => ({ type: v.model, id: v.id, version: v.version })),
        };
      }
    );
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCorrectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 身份误录更正，不删除或替换实物。 */
async function identity(ctx, unit, changes) {
  try {
    const binding = await db.PickupDevice.findOne({
      where: { stockUnitId: unit.id },
      transaction: ctx.transaction,
    });
    if (binding) {
      requirePermissions(ctx, 'stock.source.link', 'pickups.read', 'pickups.edit');
      if (
        !(await db.Order.findOne({
          where: scopeOrderWhere(ctx.user, { id: binding.orderId }),
          transaction: ctx.transaction,
        }))
      )
        throw ApiError.notFound();
    }
    const values = {};
    if (changes.serialNumber !== undefined) {
      values.serialNumber = normalizeDeviceBarcodes({
        serialBarcode: changes.serialNumber,
      }).serialNumber;
      const duplicate = await db.StockUnit.findOne({
        where: { serialNumber: values.serialNumber, id: { [Op.ne]: unit.id } },
        transaction: ctx.transaction,
      });
      if (duplicate) throw ApiError.conflict('序列号已存在', undefined, 'SN_EXISTS');
    }
    if (changes.productId !== undefined) {
      const product = await activeRow(ctx, 'StockProduct', changes.productId);
      values.productId = product.id;
      if (unit.costStatus === 'confirmed' && unit.productId !== product.id) {
        requirePermissions(ctx, 'stock.cost.edit');
        Object.assign(values, {
          costStatus: 'pending',
          officialCostAmount: null,
          priceId: null,
          costSource: null,
          costBasisCiphertext: null,
        });
      }
      const items = await db.StockSaleUnit.findAll({
        where: { stockUnitId: unit.id, status: { [Op.in]: ['picked', 'shipped'] } },
        transaction: ctx.transaction,
      });
      for (const item of items) {
        const line = await getRow('StockSaleLine', item.saleLineId, ctx);
        if (item.status === 'picked' && line.productId !== product.id) {
          await updateRow(ctx, item, { status: 'released' }, 'identity_unpick');
          const sale = await getRow('StockSale', line.saleId, ctx);
          await updateRow(ctx, sale, {}, 'identity_unpick');
        } else if (item.status === 'shipped' && line.productId !== product.id) {
          requirePermissions(ctx, 'stock.sales.ship');
          let target = await db.StockSaleLine.findOne({
            where: { saleId: line.saleId, productId: product.id },
            transaction: ctx.transaction,
          });
          if (!target)
            target = await db.StockSaleLine.create(
              {
                saleId: line.saleId,
                productId: product.id,
                quantity: 1,
                createdBy: ctx.user.id,
                updatedBy: ctx.user.id,
              },
              { transaction: ctx.transaction }
            );
          else await updateRow(ctx, target, { quantity: target.quantity + 1 }, 'identity_regroup');
          await updateRow(
            ctx,
            item,
            {
              saleLineId: target.id,
              productSnapshot: product.toJSON(),
              costAmountSnapshot:
                values.officialCostAmount === null ? null : item.costAmountSnapshot,
            },
            'identity_regroup'
          );
          const remaining = await db.StockSaleUnit.count({
            where: { saleLineId: line.id, status: 'shipped' },
            transaction: ctx.transaction,
          });
          // 历史空行保留原需求数量，当前销售显示按生效实机归组，不删除审计引用。
          if (remaining) await updateRow(ctx, line, { quantity: remaining }, 'identity_regroup');
        }
      }
    }
    await updateRow(ctx, unit, values, 'identity_correct');
    await assertStockAvailable(ctx);
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCorrectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 对录错位置及转运记录同步纠正，不作为退货入口。 */
async function location(ctx, unit, changes) {
  try {
    if (unit.state === 'sold')
      throw ApiError.conflict(
        '已售实物不可恢复在库；首期不支持退货',
        undefined,
        'CORRECTION_CONFLICT'
      );
    const state = choice(changes.state, ['registered', 'in_stock', 'in_transit']);
    const occurredAt = instant(changes.occurredAt);
    const values = { state, locationId: null };
    if (state === 'in_stock') {
      const target = await activeRow(ctx, 'StockLocation', changes.locationId);
      if (target.kind === 'historical') throw ApiError.badRequest('历史位置不可存货');
      values.locationId = target.id;
      if (!unit.productId) throw ApiError.badRequest('先明确商品规格');
    } else if (changes.locationId) throw ApiError.badRequest('非在库状态不能指定库位');
    if (
      await db.StockSaleUnit.count({
        where: { stockUnitId: unit.id, status: 'picked' },
        transaction: ctx.transaction,
      })
    )
      throw ApiError.conflict('已挑实机请先释放挑选');
    const transit = await db.StockTransferUnit.findOne({
      where: { stockUnitId: unit.id, status: 'in_transit' },
      transaction: ctx.transaction,
    });
    if (unit.state === 'in_transit' || state === 'in_transit' || transit) {
      const resolution = changes.transferResolution;
      if (!resolution) throw ApiError.badRequest('在途更正须同步转运项');
      const transfer = await getRow('StockTransfer', resolution.transferId, ctx);
      assertVersion(transfer, resolution.expectedVersion);
      if (transit && transit.transferId !== transfer.id) throw ApiError.conflict('转运单不匹配');
      const items = await db.StockTransferUnit.findAll({
        where: { transferId: transfer.id },
        transaction: ctx.transaction,
      });
      const targetChange = array(resolution.itemStates).find(item => item.unitId === unit.id);
      if (!targetChange || resolution.itemStates.length !== 1)
        throw ApiError.badRequest('本次位置更正只处理目标机器的转运项');
      const item = items.find(item => item.stockUnitId === unit.id);
      if (!item) throw ApiError.badRequest('机器不属于转运单');
      const expected =
        state === 'in_transit'
          ? 'in_transit'
          : state === 'in_stock' && values.locationId === transfer.toLocationId
            ? 'received'
            : 'cancelled';
      if (targetChange.state !== expected) throw ApiError.badRequest('位置与转运项状态不一致');
      if (+occurredAt < +new Date(transfer.dispatchedAt))
        throw ApiError.badRequest('更正实收时间不能早于发出');
      await updateRow(
        ctx,
        item,
        {
          status: expected,
          receivedAt:
            expected === 'received' ? instant(targetChange.receivedAt || changes.occurredAt) : null,
        },
        'location_correct'
      );
      const allReceived = items.every(i => i.status === 'received');
      const anyReceived = items.some(i => i.status === 'received');
      const anyTransit = items.some(i => i.status === 'in_transit');
      await updateRow(
        ctx,
        transfer,
        {
          status: allReceived
            ? 'received'
            : anyTransit
              ? anyReceived
                ? 'partially_received'
                : 'in_transit'
              : 'cancelled',
          receivedAt: allReceived ? occurredAt : null,
        },
        'location_correct'
      );
    }
    await updateRow(ctx, unit, values, 'location_correct');
    await assertStockAvailable(ctx);
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCorrectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 销售事实与其资金影响统一事务处理，业务退回不在此功能中。 */
async function saleFact(ctx, sale, changes) {
  try {
    if (sale.status !== 'shipped') throw ApiError.conflict('仅已售记录可作事实更正');
    const units = await soldUnits(ctx, sale.id);
    const values = {};
    if (changes.shippedAt !== undefined) {
      const at = instant(changes.shippedAt);
      if (sale.isHistorical) {
        const settings = await getRow('StockSetting', 1, ctx);
        if (+at >= +new Date(settings.cutoverAt))
          throw ApiError.badRequest('历史销售应早于盘点时点');
      } else
        for (const item of units)
          await assertUnitTime(ctx, await getRow('StockUnit', item.stockUnitId, ctx), at);
      values.shippedAt = at;
    }
    for (const field of ['salespersonId', 'handlerId'])
      if (changes[field] !== undefined)
        values[field] = (
          await activeRow(
            ctx,
            'StockParty',
            changes[field],
            field === 'handlerId' ? 'handler' : 'salesperson'
          )
        ).id;
    if (changes.unitPrices) {
      const prices = array(changes.unitPrices);
      if (new Set(prices.map(p => p.saleUnitId)).size !== prices.length)
        throw ApiError.badRequest('售价项重复');
      for (const price of prices) {
        const unit = units.find(item => item.id === price.saleUnitId);
        if (!unit) throw ApiError.badRequest('售价机器不属于本单');
        cents(price.amount, { positive: true });
        await updateRow(ctx, unit, { saleAmount: price.amount }, 'sale_price_correct');
      }
    }
    for (const replacement of changes.replacements || []) {
      const item = units.find(u => u.id === replacement.saleUnitId);
      if (!item) throw ApiError.badRequest('替换机器不属于本单');
      const old = await getRow('StockUnit', item.stockUnitId, ctx);
      const next = await getRow('StockUnit', replacement.newUnitId, ctx);
      const line = await getRow('StockSaleLine', item.saleLineId, ctx);
      if (
        old.id === next.id ||
        next.productId !== line.productId ||
        !['registered', 'in_stock'].includes(next.state)
      )
        throw ApiError.conflict('正确机器的规格或状态不匹配');
      if (
        await db.StockSaleUnit.count({
          where: { stockUnitId: next.id, status: { [Op.in]: ['picked', 'shipped'] } },
          transaction: ctx.transaction,
        })
      )
        throw ApiError.conflict('正确机器已有销售关联');
      const from = await getRow('StockLocation', replacement.newFromLocationId, ctx);
      if (!sale.isHistorical && (next.state !== 'in_stock' || next.locationId !== from.id))
        throw ApiError.conflict('正确机器实际位置不匹配');
      if (!sale.isHistorical) await assertUnitTime(ctx, next, values.shippedAt || sale.shippedAt);
      const state = choice(replacement.oldUnitState, ['registered', 'in_stock']);
      if (sale.isHistorical && state !== 'registered')
        throw ApiError.badRequest('历史误录仅恢复未登记身份');
      let locationId = null;
      if (state === 'in_stock') {
        locationId = (await activeRow(ctx, 'StockLocation', replacement.oldUnitLocationId)).id;
      }
      await updateRow(ctx, old, { state, locationId }, 'sale_wrong_unit_restore');
      await updateRow(ctx, next, { state: 'sold', locationId: null }, 'sale_correct_unit');
      await updateRow(
        ctx,
        item,
        {
          stockUnitId: next.id,
          fromLocationId: from.id,
          costAmountSnapshot: next.officialCostAmount,
        },
        'sale_unit_replace'
      );
    }
    const collection = await db.StockCollection.findOne({
      where: { saleId: sale.id, status: 'posted' },
      transaction: ctx.transaction,
    });
    if (changes.collectionChange) {
      if (!collection || collection.id !== changes.collectionChange.id)
        throw ApiError.badRequest('客户付款不属于该销售');
      assertVersion(collection, changes.collectionChange.expectedVersion);
      await correctCollection(ctx, collection, {
        ...changes.collectionChange,
        receiptChanges: changes.receiptChanges,
      });
    } else
      for (const change of changes.receiptChanges || []) {
        const receipt = await getRow('StockReceipt', change.id, ctx);
        assertVersion(receipt, change.expectedVersion);
        await correctReceipt(ctx, receipt, change);
      }
    if (changes.void) {
      if (collection && collection.status === 'posted')
        throw ApiError.conflict('作废销售须同时作废客户付款');
      const restores = array(changes.unitRestorations);
      if (
        restores.length !== units.length ||
        new Set(restores.map(r => r.unitId)).size !== restores.length
      )
        throw ApiError.badRequest('必须提供全部实物恢复安排');
      for (const item of units) {
        const r = restores.find(r => r.unitId === item.stockUnitId);
        if (!r) throw ApiError.badRequest('恢复清单不完整');
        const state = choice(r.state, ['registered', 'in_stock']);
        if (sale.isHistorical && state !== 'registered')
          throw ApiError.badRequest('历史误录只能恢复registered');
        const physical = await getRow('StockUnit', r.unitId, ctx);
        let locationId = null;
        if (state === 'in_stock') {
          const location = await activeRow(ctx, 'StockLocation', r.locationId);
          if (location.kind === 'historical') throw ApiError.badRequest('不能恢复至历史位置');
          locationId = location.id;
        }
        await updateRow(ctx, item, { status: 'voided' }, 'sale_void');
        await updateRow(ctx, physical, { state, locationId }, 'sale_void_restore');
      }
      const expenses = await db.StockExpense.findAll({
        where: { saleId: sale.id, status: 'active' },
        transaction: ctx.transaction,
      });
      if (expenses.length) requirePermissions(ctx, 'stock.expenses.edit');
      for (const e of expenses) await updateRow(ctx, e, { status: 'voided' }, 'sale_void_expense');
      values.status = 'voided';
    } else if (changes.replacements?.length) {
      const expenses = await db.StockExpense.findAll({
        where: { saleId: sale.id, status: 'active' },
        transaction: ctx.transaction,
      });
      for (const e of expenses) {
        const allocations = await db.StockExpenseAllocation.findAll({
          where: { expenseId: e.id, expenseVersion: e.version },
          transaction: ctx.transaction,
        });
        await updateRow(ctx, e, {}, 'replacement_reallocate');
        await allocateExpense(
          ctx,
          e,
          allocations.map(a => a.saleUnitId)
        );
      }
    }
    await updateRow(ctx, sale, values, 'sale_fact_correct');
    await assertStockAvailable(ctx);
    await assertFinanceConsistent(ctx);
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCorrectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 提交时重新认证令牌与所有依赖版本，然后原子应用。 */
async function applyCorrection(ctx, input) {
  try {
    validate(ctx, input);
    let token;
    try {
      if (typeof input.previewToken !== 'string' || !input.previewToken.startsWith('enc:'))
        throw new Error('invalid');
      token = JSON.parse(decrypt(input.previewToken));
    } catch (_error) {
      throw ApiError.badRequest('更正预览令牌无效');
    }
    if (
      token.purpose !== 'stock_correction' ||
      token.userId !== ctx.user.id ||
      token.requestHash !== digest(payload(input)) ||
      token.expiresAt < Date.now()
    )
      throw ApiError.conflict('更正预览已失效', undefined, 'CORRECTION_CONFLICT');
    const { row, versions } = await dependencies(ctx, input);
    if (digest(versions) !== digest(token.targetVersions))
      throw ApiError.conflict('关联记录已变化，请重新预览', undefined, 'VERSION_CONFLICT');
    if (input.kind === 'unit_identity') await identity(ctx, row, input.changes);
    else if (input.kind === 'unit_location') await location(ctx, row, input.changes);
    else if (input.kind === 'sale_fact') await saleFact(ctx, row, input.changes);
    else if (input.kind === 'collection_fact') {
      await correctCollection(ctx, row, input.changes);
      await assertFinanceConsistent(ctx);
    } else {
      await correctReceipt(ctx, row, input.changes);
      await assertFinanceConsistent(ctx);
    }
    return { kind: input.kind, targetId: row.id };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCorrectionService',
      code: error.code || error.name,
    });
    throw error;
  }
}
module.exports = { previewCorrection, applyCorrection };
