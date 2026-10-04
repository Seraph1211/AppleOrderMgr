const logger = require('../utils/logger');
const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { encrypt } = require('../utils/fieldEncryption');
const { array, uuid, text, instant, choice } = require('../utils/stockRules');
const { cents } = require('../utils/stockMoney');
const { activeRow, ensureUnit, costValues, bindSource } = require('./stockUnitService');
const { normalizeDeviceBarcodes } = require('./pickupDeviceRules');
const {
  requirePermissions,
  getRow,
  assertVersion,
  updateRow,
  recordEvent,
} = require('./stockCommandService');
/** 规格库存和占用来自同一条聚合查询，picked不二扣。 */
async function inventoryCounts(ctx) {
  try {
    const [rows] = await db.sequelize.query(
      `SELECT p.id AS "productId",
      COALESCE(q.quantity,0)::integer AS quantity,COALESCE(r.reserved,0)::integer AS reserved
      FROM stock_products p
      LEFT JOIN (SELECT u.product_id,count(*) quantity FROM stock_units u JOIN stock_locations l ON l.id=u.location_id WHERE u.state='in_stock' AND l.kind='warehouse' GROUP BY u.product_id) q ON q.product_id=p.id
      LEFT JOIN (SELECT sl.product_id,sum(sl.quantity) reserved FROM stock_sale_lines sl JOIN stock_sales s ON s.id=sl.sale_id WHERE s.status='reserved' AND s.channel='local' GROUP BY sl.product_id) r ON r.product_id=p.id`,
      { transaction: ctx.transaction }
    );
    return new Map(
      rows.map(row => [row.productId, { ...row, available: row.quantity - row.reserved }])
    );
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 生效后校验没有负可售。 */
async function assertStockAvailable(ctx) {
  try {
    if ([...(await inventoryCounts(ctx)).values()].some(row => row.available < 0))
      throw ApiError.conflict('现货不足，无法占用或移出', undefined, 'INSUFFICIENT_STOCK');
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 真实售出或调出不得早于有据的最近实收时间；不比较系统录入时间。 */
async function assertUnitTime(ctx, unit, time) {
  try {
    const latest = await db.StockTransferUnit.findOne({
      where: { stockUnitId: unit.id, status: 'received' },
      order: [['receivedAt', 'DESC']],
      transaction: ctx.transaction,
    });
    const first = unit.firstReceivedAt ? +new Date(unit.firstReceivedAt) : 0;
    const last = latest?.receivedAt ? +new Date(latest.receivedAt) : 0;
    if (+time < Math.max(first, last))
      throw ApiError.badRequest('业务时间早于该机器实际收货时间', undefined, 'DATE_INVALID');
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 独立序列生成可追溯销售编号。 */
async function nextSaleNo(ctx) {
  try {
    const [rows] = await db.sequelize.query("SELECT nextval('stock_sale_number_seq') AS n", {
      transaction: ctx.transaction,
    });
    return `S${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '')}-${String(rows[0].n).padStart(6, '0')}`;
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 验证需求行并合并完全相同规格。 */
async function validatedLines(ctx, input) {
  try {
    const lines = array(input, 20);
    const result = new Map();
    let total = 0;
    for (const line of lines) {
      await activeRow(ctx, 'StockProduct', line.productId);
      if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 100)
        throw ApiError.badRequest('需求数量须为1至100');
      if (line.quotedUnitAmount != null) cents(line.quotedUnitAmount, { positive: true });
      if (result.has(line.productId)) throw ApiError.badRequest('同规格请合并为一行');
      result.set(line.productId, {
        productId: line.productId,
        quantity: line.quantity,
        quotedUnitAmount: line.quotedUnitAmount ?? null,
      });
      total += line.quantity;
    }
    if (total > 100) throw ApiError.badRequest('一单最多100台');
    return [...result.values()];
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 创建/调整未出货销售，不把接单写成出货。 */
async function saveSale(ctx, id, input) {
  try {
    requirePermissions(ctx, 'stock.sales.edit');
    const current = id ? await getRow('StockSale', id, ctx) : null;
    if (current) {
      assertVersion(current, input.expectedVersion);
      if (!['draft', 'reserved'].includes(current.status))
        throw ApiError.conflict('仅未出货销售可编辑');
    }
    if (input.channel && input.channel !== 'local')
      throw ApiError.badRequest('代卖售出使用专用登记');
    const values = { channel: 'local' };
    for (const [field, role] of [
      ['customerId', 'customer'],
      ['salespersonId', 'salesperson'],
    ]) {
      const value = input[field] !== undefined ? input[field] : current?.[field];
      if (value) values[field] = (await activeRow(ctx, 'StockParty', value, role)).id;
      else values[field] = null;
    }
    if (input.notes !== undefined)
      values.notesCiphertext = encrypt(text(input.notes, '备注', 2000, true));
    let sale = current;
    if (!sale) {
      sale = await db.StockSale.create(
        {
          ...values,
          saleNo: await nextSaleNo(ctx),
          createdBy: ctx.user.id,
          updatedBy: ctx.user.id,
        },
        { transaction: ctx.transaction }
      );
      await recordEvent(ctx, 'StockSale', sale, 'sale_create');
    } else await updateRow(ctx, sale, values, 'sale_edit');
    if (input.lines !== undefined || !current) {
      const lines = await validatedLines(ctx, input.lines);
      const previous = await db.StockSaleLine.findAll({
        where: { saleId: sale.id },
        transaction: ctx.transaction,
      });
      let picks = [];
      if (previous.length) {
        picks = await db.StockSaleUnit.findAll({
          where: { saleLineId: { [Op.in]: previous.map(line => line.id) }, status: 'picked' },
          transaction: ctx.transaction,
        });
      }
      for (const old of previous) {
        const replacement = lines.find(line => line.productId === old.productId);
        const count = picks.filter(unit => unit.saleLineId === old.id).length;
        if (count > (replacement?.quantity || 0))
          throw ApiError.conflict('需求数量不能小于已挑数量');
        if (!replacement) {
          // 保留有历史挑选的行，避免删除历史关系；标记取消需求为0不符合契约，故拒绝。
          if (
            await db.StockSaleUnit.count({
              where: { saleLineId: old.id },
              transaction: ctx.transaction,
            })
          )
            throw ApiError.conflict('已有挑货历史的规格不能删除；可取消此单再接单');
          await old.destroy({ transaction: ctx.transaction });
        }
      }
      for (const line of lines) {
        const old = previous.find(row => row.productId === line.productId);
        if (old) await updateRow(ctx, old, line, 'line_edit');
        else
          await db.StockSaleLine.create(
            { ...line, saleId: sale.id, createdBy: ctx.user.id, updatedBy: ctx.user.id },
            { transaction: ctx.transaction }
          );
      }
    }
    if (sale.status === 'reserved') {
      if (!sale.customerId || !sale.salespersonId)
        throw ApiError.badRequest('已接单必须有客户和销售负责人');
      await assertStockAvailable(ctx);
    }
    return { saleId: sale.id };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 整单数量占用。 */
async function reserveSale(ctx, id, input) {
  try {
    const sale = await getRow('StockSale', id, ctx);
    assertVersion(sale, input.expectedVersion);
    if (sale.status !== 'draft') throw ApiError.conflict('销售状态不可接单');
    if (!sale.customerId || !sale.salespersonId)
      throw ApiError.badRequest('接单前请选择客户和销售负责人');
    if (!(await db.StockSaleLine.count({ where: { saleId: id }, transaction: ctx.transaction })))
      throw ApiError.badRequest('没有需求规格');
    await updateRow(ctx, sale, { status: 'reserved' }, 'reserve');
    await assertStockAvailable(ctx);
    return { saleId: id };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 替换本单完整挑货集合；暂存不要求挑齐。 */
async function pickUnits(ctx, id, input) {
  try {
    const sale = await getRow('StockSale', id, ctx);
    assertVersion(sale, input.expectedVersion);
    if (sale.status !== 'reserved') throw ApiError.conflict('仅已接单销售可挑货');
    const items = array(input.units, 100, true);
    const ids = items.map(item => uuid(item.unitId));
    if (new Set(ids).size !== ids.length) throw ApiError.badRequest('挑货序列号重复');
    const lines = await db.StockSaleLine.findAll({
      where: { saleId: id },
      transaction: ctx.transaction,
    });
    const existing = await db.StockSaleUnit.findAll({
      where: { saleLineId: { [Op.in]: lines.map(l => l.id) }, status: 'picked' },
      transaction: ctx.transaction,
    });
    for (const old of existing)
      if (!ids.includes(old.stockUnitId))
        await updateRow(ctx, old, { status: 'released' }, 'unpick');
    const counts = new Map();
    for (const item of items) {
      const line = lines.find(row => row.id === item.lineId);
      if (!line) throw ApiError.badRequest('规格需求不存在');
      counts.set(line.id, (counts.get(line.id) || 0) + 1);
      if (counts.get(line.id) > line.quantity) throw ApiError.badRequest('挑货超过需求数量');
      const unit = await getRow('StockUnit', item.unitId, ctx);
      const location = unit.locationId ? await getRow('StockLocation', unit.locationId, ctx) : null;
      if (
        unit.state !== 'in_stock' ||
        location?.kind !== 'warehouse' ||
        unit.productId !== line.productId
      )
        throw ApiError.conflict('机器位置、状态或规格不匹配', undefined, 'UNIT_STATE_CONFLICT');
      const held = await db.StockSaleUnit.findOne({
        where: { stockUnitId: unit.id, status: { [Op.in]: ['picked', 'shipped'] } },
        transaction: ctx.transaction,
      });
      if (held && !existing.some(old => old.id === held.id))
        throw ApiError.conflict('机器已被选用', undefined, 'UNIT_ALREADY_PICKED');
      if (item.saleAmount != null) cents(item.saleAmount, { positive: true });
      const values = {
        saleLineId: line.id,
        fromLocationId: unit.locationId,
        saleAmount: item.saleAmount ?? null,
      };
      if (held) await updateRow(ctx, held, values, 'pick_price');
      else {
        const product = await getRow('StockProduct', unit.productId, ctx);
        await db.StockSaleUnit.create(
          {
            ...values,
            stockUnitId: unit.id,
            status: 'picked',
            productSnapshot: product.toJSON(),
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          },
          { transaction: ctx.transaction }
        );
      }
    }
    await updateRow(ctx, sale, {}, 'picks');
    return { saleId: id };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 一次交齐、跨仓原子出货。 */
async function shipSale(ctx, id, input) {
  try {
    const sale = await getRow('StockSale', id, ctx);
    assertVersion(sale, input.expectedVersion);
    if (sale.status !== 'reserved') throw ApiError.conflict('销售状态不可出货');
    const shippedAt = instant(input.shippedAt);
    await activeRow(ctx, 'StockParty', input.handlerId, 'handler');
    const lines = await db.StockSaleLine.findAll({
      where: { saleId: id },
      transaction: ctx.transaction,
    });
    const units = await db.StockSaleUnit.findAll({
      where: { saleLineId: { [Op.in]: lines.map(l => l.id) }, status: 'picked' },
      transaction: ctx.transaction,
    });
    if (
      lines.some(line => units.filter(unit => unit.saleLineId === line.id).length !== line.quantity)
    )
      throw ApiError.conflict('请按需求挑齐全部机器', undefined, 'SHIPMENT_INCOMPLETE');
    const prices = array(input.unitPrices, 100);
    if (
      prices.length !== units.length ||
      new Set(prices.map(p => p.saleUnitId)).size !== prices.length
    )
      throw ApiError.badRequest('请提供每台准确售价');
    for (const item of units) {
      const price = prices.find(p => p.saleUnitId === item.id);
      if (!price) throw ApiError.badRequest('缺少逐台售价');
      cents(price.amount, { positive: true });
      const unit = await getRow('StockUnit', item.stockUnitId, ctx);
      if (unit.state !== 'in_stock' || unit.locationId !== item.fromLocationId)
        throw ApiError.conflict('机器状态变化', undefined, 'UNIT_STATE_CONFLICT');
      await assertUnitTime(ctx, unit, shippedAt);
      await updateRow(
        ctx,
        item,
        {
          status: 'shipped',
          saleAmount: price.amount,
          costAmountSnapshot: unit.officialCostAmount,
        },
        'ship'
      );
      await updateRow(ctx, unit, { state: 'sold', locationId: null }, 'sold');
    }
    await updateRow(
      ctx,
      sale,
      { status: 'shipped', shippedAt, handlerId: input.handlerId },
      'ship'
    );
    await assertStockAvailable(ctx);
    if (input.collection)
      await require('./stockFinanceService').createCollection(ctx, {
        ...input.collection,
        saleId: id,
      });
    return { saleId: id };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 取消未出货单释放数量和SN。 */
async function cancelSale(ctx, id, input) {
  try {
    const sale = await getRow('StockSale', id, ctx);
    assertVersion(sale, input.expectedVersion);
    text(input.reason, '取消原因', 500);
    if (!['draft', 'reserved'].includes(sale.status)) throw ApiError.conflict('仅未出货单可取消');
    const lines = await db.StockSaleLine.findAll({
      where: { saleId: id },
      transaction: ctx.transaction,
    });
    const picks = await db.StockSaleUnit.findAll({
      where: { saleLineId: { [Op.in]: lines.map(l => l.id) }, status: 'picked' },
      transaction: ctx.transaction,
    });
    for (const item of picks) await updateRow(ctx, item, { status: 'released' }, 'cancel_pick');
    await updateRow(ctx, sale, { status: 'cancelled' }, 'cancel');
    return { saleId: id };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 代卖实际售出，未售的SN继续保留库存。 */
async function consignmentSale(ctx, input) {
  try {
    const location = await activeRow(ctx, 'StockLocation', input.locationId);
    if (location.kind !== 'consignee') throw ApiError.badRequest('请选择代卖位置');
    const sale = await createShippedHeader(ctx, {
      ...input,
      channel: 'consignment',
      consigneeLocationId: location.id,
    });
    const inputs = array(input.units, 100);
    const seen = new Set();
    const grouped = new Map();
    for (const item of inputs) {
      if (seen.has(item.unitId)) throw ApiError.badRequest('序列号重复');
      seen.add(item.unitId);
      const unit = await getRow('StockUnit', item.unitId, ctx);
      if (unit.state !== 'in_stock' || unit.locationId !== location.id)
        throw ApiError.conflict('机器不在该代卖位置', undefined, 'UNIT_STATE_CONFLICT');
      await assertUnitTime(ctx, unit, sale.shippedAt);
      cents(item.saleAmount, { positive: true });
      const list = grouped.get(unit.productId) || [];
      list.push({ unit, amount: item.saleAmount, locationId: location.id });
      grouped.set(unit.productId, list);
    }
    await createSoldLines(ctx, sale, grouped);
    return { saleId: sale.id };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 创建有明确人员日期的已售表头。 */
async function createShippedHeader(ctx, input, historical = false) {
  try {
    requirePermissions(ctx, 'stock.sales.ship');
    await activeRow(ctx, 'StockParty', input.salespersonId, 'salesperson');
    await activeRow(ctx, 'StockParty', input.handlerId, 'handler');
    if (input.customerId) await activeRow(ctx, 'StockParty', input.customerId, 'customer');
    const sale = await db.StockSale.create(
      {
        saleNo: await nextSaleNo(ctx),
        channel: choice(input.channel || 'local', ['local', 'consignment']),
        status: 'shipped',
        customerId: input.customerId || null,
        salespersonId: input.salespersonId,
        handlerId: input.handlerId,
        consigneeLocationId: input.consigneeLocationId || null,
        shippedAt: instant(input.shippedAt),
        isHistorical: historical,
        notesCiphertext: encrypt(text(input.notes, '备注', 2000, true)),
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      },
      { transaction: ctx.transaction }
    );
    await recordEvent(ctx, 'StockSale', sale, historical ? 'historical_sale' : 'consignment_sale');
    return sale;
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 按规格归组生效明细，仅在模块锁内调用。 */
async function createSoldLines(ctx, sale, groups) {
  try {
    for (const [productId, items] of groups) {
      const product = await getRow('StockProduct', productId, ctx);
      const line = await db.StockSaleLine.create(
        {
          saleId: sale.id,
          productId,
          quantity: items.length,
          createdBy: ctx.user.id,
          updatedBy: ctx.user.id,
        },
        { transaction: ctx.transaction }
      );
      for (const item of items) {
        await db.StockSaleUnit.create(
          {
            saleLineId: line.id,
            stockUnitId: item.unit.id,
            fromLocationId: item.locationId,
            status: 'shipped',
            saleAmount: item.amount,
            costAmountSnapshot: item.unit.officialCostAmount,
            productSnapshot: product.toJSON(),
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          },
          { transaction: ctx.transaction }
        );
        await updateRow(
          ctx,
          item.unit,
          { state: 'sold', locationId: null },
          sale.isHistorical ? 'historical_sold' : 'sold'
        );
      }
    }
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
/** 历史已售不借道当前现货，不产生虚构扣减。 */
async function importHistoricalSale(ctx, input) {
  try {
    requirePermissions(ctx, 'stock.import', 'stock.sales.ship');
    const settings = await getRow('StockSetting', 1, ctx);
    const shippedAt = instant(input.shippedAt);
    if (!settings.cutoverAt || +shippedAt >= +new Date(settings.cutoverAt))
      throw ApiError.badRequest('历史销售必须早于启用盘点时点');
    const sale = await createShippedHeader(ctx, input, true);
    const historical = await db.StockLocation.findOne({
      where: { kind: 'historical' },
      transaction: ctx.transaction,
    });
    const groups = new Map();
    const seen = new Set();
    for (const item of array(input.units, 500)) {
      const { serialNumber } = normalizeDeviceBarcodes(item);
      if (seen.has(serialNumber)) throw ApiError.badRequest('历史批次序列号重复');
      seen.add(serialNumber);
      const unit = await ensureUnit(ctx, serialNumber, 'history');
      if (unit.state !== 'registered')
        throw ApiError.conflict('历史SN与当前实物账冲突', undefined, 'UNIT_STATE_CONFLICT');
      if (
        (unit.productId && unit.productId !== item.productId) ||
        (unit.costStatus === 'confirmed' &&
          (item.cost || (item.acquiredOn && item.acquiredOn !== unit.acquiredOn)))
      )
        throw ApiError.conflict(
          '历史导入不得改写已有身份或成本，请先更正',
          undefined,
          'CORRECTION_CONFLICT'
        );
      await activeRow(ctx, 'StockProduct', item.productId);
      cents(item.saleAmount, { positive: true });
      const locationId = item.fromLocationId || historical.id;
      if (item.fromLocationId) await getRow('StockLocation', locationId, ctx);
      const cost = await costValues(ctx, item.productId, item.acquiredOn, item.cost);
      await updateRow(ctx, unit, { productId: item.productId, ...cost }, 'history_details');
      if (item.sourceOrderId !== undefined) await bindSource(ctx, unit, item.sourceOrderId, null);
      const items = groups.get(item.productId) || [];
      items.push({ unit, amount: item.saleAmount, locationId });
      groups.set(item.productId, items);
    }
    await createSoldLines(ctx, sale, groups);
    return { saleId: sale.id };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockSalesService', code: error.code || error.name });
    throw error;
  }
}
module.exports = {
  inventoryCounts,
  assertStockAvailable,
  assertUnitTime,
  saveSale,
  reserveSale,
  pickUnits,
  shipSale,
  cancelSale,
  consignmentSale,
  importHistoricalSale,
};
