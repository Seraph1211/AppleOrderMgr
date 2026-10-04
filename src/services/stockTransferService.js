const logger = require('../utils/logger');
const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { encrypt } = require('../utils/fieldEncryption');
const { array, uuid, text, instant } = require('../utils/stockRules');
const { activeRow } = require('./stockUnitService');
const { assertStockAvailable, assertUnitTime } = require('./stockSalesService');
const { getRow, assertVersion, updateRow, recordEvent } = require('./stockCommandService');
/** 建立未发出转运计划。 */
async function createTransfer(ctx, input) {
  try {
    const to = await activeRow(ctx, 'StockLocation', input.toLocationId);
    if (to.kind === 'historical') throw ApiError.badRequest('不能转往历史位置');
    let from = null;
    if (input.fromLocationId) from = await activeRow(ctx, 'StockLocation', input.fromLocationId);
    if (from?.id === to.id || from?.kind === 'historical') throw ApiError.badRequest('起终点无效');
    await activeRow(ctx, 'StockParty', input.handlerId, 'handler');
    const unitIds = array(input.unitIds).map(id => uuid(id));
    if (new Set(unitIds).size !== unitIds.length) throw ApiError.badRequest('转运SN重复');
    const transfer = await db.StockTransfer.create(
      {
        fromLocationId: from?.id || null,
        originLabel: from ? null : text(input.originLabel, '取出起点'),
        toLocationId: to.id,
        handlerId: input.handlerId,
        notesCiphertext: encrypt(text(input.notes, '备注', 2000, true)),
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      },
      { transaction: ctx.transaction }
    );
    for (const id of unitIds) {
      const unit = await getRow('StockUnit', id, ctx);
      if (
        !unit.productId ||
        (from
          ? unit.state !== 'in_stock' || unit.locationId !== from.id
          : unit.state !== 'registered')
      )
        throw ApiError.conflict('机器不符合起点状态', undefined, 'UNIT_STATE_CONFLICT');
      await db.StockTransferUnit.create(
        {
          transferId: transfer.id,
          stockUnitId: id,
          createdBy: ctx.user.id,
          updatedBy: ctx.user.id,
        },
        { transaction: ctx.transaction }
      );
    }
    await recordEvent(ctx, 'StockTransfer', transfer, 'transfer_create');
    return { transferId: transfer.id };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockTransferService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 转运发出时才移出现货，已有占用不可被破坏。 */
async function dispatchTransfer(ctx, id, input) {
  try {
    const transfer = await getRow('StockTransfer', id, ctx);
    assertVersion(transfer, input.expectedVersion);
    if (transfer.status !== 'draft') throw ApiError.conflict('仅草稿转运可发出');
    const at = instant(input.dispatchedAt);
    const items = await db.StockTransferUnit.findAll({
      where: { transferId: id },
      transaction: ctx.transaction,
    });
    for (const item of items) {
      const unit = await getRow('StockUnit', item.stockUnitId, ctx);
      if (
        transfer.fromLocationId
          ? unit.state !== 'in_stock' || unit.locationId !== transfer.fromLocationId
          : unit.state !== 'registered'
      )
        throw ApiError.conflict('机器状态已变化', undefined, 'UNIT_STATE_CONFLICT');
      if (
        await db.StockSaleUnit.count({
          where: { stockUnitId: unit.id, status: { [Op.in]: ['picked', 'shipped'] } },
          transaction: ctx.transaction,
        })
      )
        throw ApiError.conflict('已挑机器不可转运', undefined, 'UNIT_ALREADY_PICKED');
      await assertUnitTime(ctx, unit, at);
      await updateRow(ctx, item, { status: 'in_transit' }, 'dispatch');
      await updateRow(ctx, unit, { state: 'in_transit', locationId: null }, 'dispatch');
    }
    await updateRow(ctx, transfer, { status: 'in_transit', dispatchedAt: at }, 'dispatch');
    await assertStockAvailable(ctx);
    return { transferId: id };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockTransferService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 在目的地逐批实收，不双计库存。 */
async function receiveTransfer(ctx, id, input) {
  try {
    const transfer = await getRow('StockTransfer', id, ctx);
    assertVersion(transfer, input.expectedVersion);
    if (!['in_transit', 'partially_received'].includes(transfer.status))
      throw ApiError.conflict('转运状态不能接收');
    const at = instant(input.receivedAt);
    if (+at < +new Date(transfer.dispatchedAt))
      throw ApiError.badRequest('实收不能早于发出', undefined, 'DATE_INVALID');
    const ids = array(input.unitIds).map(value => uuid(value));
    if (new Set(ids).size !== ids.length) throw ApiError.badRequest('重复机器');
    const items = await db.StockTransferUnit.findAll({
      where: { transferId: id },
      transaction: ctx.transaction,
    });
    for (const unitId of ids) {
      const item = items.find(row => row.stockUnitId === unitId && row.status === 'in_transit');
      if (!item) throw ApiError.conflict('机器不是该单在途项');
      const unit = await getRow('StockUnit', unitId, ctx);
      if (unit.state !== 'in_transit') throw ApiError.conflict('机器不在途');
      await updateRow(ctx, item, { status: 'received', receivedAt: at }, 'transfer_receive');
      await updateRow(
        ctx,
        unit,
        {
          state: 'in_stock',
          locationId: transfer.toLocationId,
          firstReceivedAt: unit.firstReceivedAt || at,
        },
        'transfer_receive'
      );
    }
    const complete = items.every(item => item.status === 'received');
    const latestAt = new Date(
      Math.max(...items.filter(item => item.receivedAt).map(item => +new Date(item.receivedAt)))
    );
    await updateRow(
      ctx,
      transfer,
      {
        status: complete ? 'received' : 'partially_received',
        receivedAt: complete ? latestAt : null,
      },
      'transfer_receive'
    );
    return { transferId: id };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockTransferService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 仅取消尚未发出的计划。 */
async function cancelTransfer(ctx, id, input) {
  try {
    const transfer = await getRow('StockTransfer', id, ctx);
    assertVersion(transfer, input.expectedVersion);
    text(input.reason, '取消原因', 500);
    if (transfer.status !== 'draft') throw ApiError.conflict('已发出转运不能取消草稿');
    const items = await db.StockTransferUnit.findAll({
      where: { transferId: id },
      transaction: ctx.transaction,
    });
    for (const item of items) await updateRow(ctx, item, { status: 'cancelled' }, 'cancel');
    await updateRow(ctx, transfer, { status: 'cancelled' }, 'cancel');
    return { transferId: id };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockTransferService',
      code: error.code || error.name,
    });
    throw error;
  }
}
module.exports = { createTransfer, dispatchTransfer, receiveTransfer, cancelTransfer };
