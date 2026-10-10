const { assertLifecycleWritable } = require('./stockLifecycleRules');
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { encrypt } = require('../utils/fieldEncryption');
const { normalizeDeviceBarcodes } = require('./pickupDeviceRules');
const { scopeOrderWhere } = require('./orderAccessService');
const {
  requirePermissions,
  requireField,
  getRow,
  assertVersion,
  recordEvent,
  updateRow,
} = require('./stockCommandService');
const { uuid, text, instant, dateOnly, array, choice } = require('../utils/stockRules');
const { cents } = require('../utils/stockMoney');
/** 校验可用资料，可选角色。 */
async function activeRow(ctx, model, id, role) {
  try {
    const row = await getRow(model, id, ctx);
    if (!row.isActive || (role && !row.roles?.includes(role)))
      throw ApiError.badRequest('资料已停用或角色不匹配');
    return row;
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockUnitService', code: error.code || error.name });
    throw error;
  }
}
/** 校验并冻结实机官网成本。 */
async function costValues(ctx, productId, acquiredOn, cost) {
  try {
    if (cost === undefined) return {};
    requireField(ctx, 'stock.cost.edit');
    choice(cost.status, ['pending', 'confirmed']);
    if (cost.status === 'pending') {
      if (cost.amount != null) throw ApiError.badRequest('待核实成本不能提供金额');
      return {
        acquiredOn: acquiredOn ? dateOnly(acquiredOn) : null,
        costStatus: 'pending',
        officialCostAmount: null,
        priceId: null,
        costSource: null,
        costBasisCiphertext: null,
      };
    }
    dateOnly(acquiredOn);
    cents(cost.amount, { positive: true });
    choice(cost.source, ['catalog', 'manual']);
    if (cost.source === 'catalog') {
      const price = await getRow('StockOfficialPrice', cost.priceId, ctx);
      if (
        price.productId !== productId ||
        !price.isActive ||
        acquiredOn < price.validFrom ||
        (price.validTo && acquiredOn >= price.validTo) ||
        price.amount !== cost.amount
      )
        throw ApiError.badRequest('官网价格版本与商品、拿货日或金额不一致');
    } else if (cost.priceId) throw ApiError.badRequest('人工核定不能指定目录版本');
    return {
      acquiredOn,
      costStatus: 'confirmed',
      officialCostAmount: cost.amount,
      priceId: cost.priceId || null,
      costSource: cost.source,
      costBasisCiphertext: encrypt(text(cost.basis, '依据', 1000, true)),
    };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockUnitService', code: error.code || error.name });
    throw error;
  }
}
/** 不依赖订单的稳定 SN 身份。 */
async function ensureUnit(ctx, serialNumber, originMode = 'legacy_binding') {
  try {
    let unit = await db.StockUnit.findOne({
      where: { serialNumber },
      transaction: ctx.transaction,
    });
    if (!unit) {
      unit = await db.StockUnit.create(
        { serialNumber, originMode, createdBy: ctx.user.id, updatedBy: ctx.user.id },
        { transaction: ctx.transaction }
      );
      await recordEvent(ctx, 'StockUnit', unit, 'register');
    }
    return unit;
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockUnitService', code: error.code || error.name });
    throw error;
  }
}
/** 同时核验旧新订单 TAG，统一旧扫码与新来源关联。 */
async function bindSource(ctx, unit, orderId, bindingId, { legacy = false } = {}) {
  try {
    if (!legacy) requirePermissions(ctx, 'stock.source.link', 'pickups.read', 'pickups.edit');
    const binding = await db.PickupDevice.findOne({
      where: { serialNumber: unit.serialNumber },
      transaction: ctx.transaction,
    });
    const ids = [...new Set([binding?.orderId, orderId].filter(id => id != null))];
    for (const id of ids) {
      if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0)
        throw ApiError.badRequest('来源订单无效');
      const order = await db.Order.findOne({
        where: scopeOrderWhere(ctx.user, { id: Number(id) }),
        transaction: ctx.transaction,
        lock: ctx.transaction.LOCK.UPDATE,
      });
      if (!order) throw ApiError.notFound('订单不存在或不可访问');
    }
    if (binding && binding.orderId === Number(orderId)) {
      if (!binding.stockUnitId)
        await binding.update({ stockUnitId: unit.id }, { transaction: ctx.transaction });
      return binding;
    }
    assertLifecycleWritable(unit);
    if (binding && (legacy || binding.id !== bindingId))
      throw ApiError.conflict('来源绑定已变化，请刷新核对', undefined, 'SOURCE_BINDING_CONFLICT');
    if (!binding && bindingId)
      throw ApiError.conflict('来源绑定已变化', undefined, 'SOURCE_BINDING_CONFLICT');
    if (binding) {
      await pickupEvent(ctx, binding.orderId, binding, 'device_removed');
      await binding.destroy({ transaction: ctx.transaction });
    }
    let next = null;
    if (orderId != null) {
      next = await db.PickupDevice.create(
        {
          stockUnitId: unit.id,
          orderId: Number(orderId),
          serialNumber: unit.serialNumber,
          serialBarcode: unit.serialNumber,
          scannedBy: ctx.user.id,
        },
        { transaction: ctx.transaction }
      );
      await pickupEvent(ctx, Number(orderId), next, 'device_added');
    }
    const before = {
      ...unit.toJSON(),
      sourceBinding: binding ? { id: binding.id, orderId: binding.orderId } : null,
    };
    await updateRow(ctx, unit, {}, 'source_order');
    await recordEvent(
      ctx,
      'StockUnit',
      { ...unit.toJSON(), sourceBinding: next ? { id: next.id, orderId: next.orderId } : null },
      'source_binding_details',
      before
    );
    return next;
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockUnitService', code: error.code || error.name });
    throw error;
  }
}
/** 保留旧取货审计及版本语义。 */
async function pickupEvent(ctx, orderId, device, eventType) {
  try {
    let record = await db.PickupRecord.findOne({
      where: { orderId },
      transaction: ctx.transaction,
    });
    if (!record)
      record = await db.PickupRecord.create({ orderId }, { transaction: ctx.transaction });
    const beforeVersion = record.version;
    await record.update(
      { version: beforeVersion + 1, lastUpdatedBy: ctx.user.id },
      { transaction: ctx.transaction }
    );
    await db.PickupRecordEvent.create(
      {
        pickupRecordId: record.id,
        orderId,
        actorUserId: ctx.user.id,
        actorName: ctx.user.nickname || ctx.user.username,
        eventType,
        changes: { device: { id: device.id, serialNumber: device.serialNumber } },
        beforeVersion,
        afterVersion: record.version,
      },
      { transaction: ctx.transaction }
    );
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockUnitService', code: error.code || error.name });
    throw error;
  }
}
/** 批量收货或仅登记取出待直发，整批由外层统一事务。 */
async function receiveUnits(ctx, input, registerOnly = false) {
  try {
    requirePermissions(ctx, 'stock.receive');
    const mode = choice(input.mode || 'current', ['current', 'opening']);
    if (mode === 'opening') requirePermissions(ctx, 'stock.import');
    const settings = await db.StockSetting.findByPk(1, { transaction: ctx.transaction });
    if (mode === 'opening' && !settings.cutoverAt) throw ApiError.badRequest('先设置启用盘点时点');
    const inputs = array(input.units, ctx.importing ? 500 : 100);
    const sns = new Set();
    const unitIds = [];
    for (const item of inputs) {
      const { serialNumber } = normalizeDeviceBarcodes(item);
      if (sns.has(serialNumber))
        throw ApiError.conflict('批次内序列号重复', undefined, 'SN_EXISTS');
      sns.add(serialNumber);
      await activeRow(ctx, 'StockProduct', item.productId);
      const unit = await ensureUnit(ctx, serialNumber, mode);
      if (unit.state !== 'registered')
        throw ApiError.conflict('序列号已进入实物账', undefined, 'UNIT_STATE_CONFLICT');
      if (
        (unit.productId && unit.productId !== item.productId) ||
        (unit.costStatus === 'confirmed' && item.acquiredOn && item.acquiredOn !== unit.acquiredOn)
      )
        throw ApiError.conflict(
          '已有身份或成本依据不可通过收货改写，请先更正',
          undefined,
          'CORRECTION_CONFLICT'
        );
      const values = { productId: item.productId };
      if (item.acquiredOn) values.acquiredOn = dateOnly(item.acquiredOn);
      if (item.cost && unit.costStatus === 'confirmed') requirePermissions(ctx, 'stock.correct');
      Object.assign(
        values,
        await costValues(ctx, item.productId, item.acquiredOn || unit.acquiredOn, item.cost)
      );
      if (!registerOnly) {
        const location = await activeRow(ctx, 'StockLocation', item.locationId);
        if (location.kind === 'historical') throw ApiError.badRequest('不能收货至历史地点');
        const receivedAt = instant(item.receivedAt);
        if (mode === 'opening' && +receivedAt !== +new Date(settings.cutoverAt))
          throw ApiError.badRequest('期初收货时点应等于启用盘点时点');
        Object.assign(values, {
          state: 'in_stock',
          locationId: location.id,
          firstReceivedAt: receivedAt,
        });
      }
      await updateRow(ctx, unit, values, registerOnly ? 'register_details' : 'receive');
      if (item.sourceOrderId !== undefined) await bindSource(ctx, unit, item.sourceOrderId, null);
      if (item.attachmentIds?.length) {
        for (const id of array(item.attachmentIds, 20)) {
          const attachment = await getRow('StockAttachment', id, ctx);
          if (attachment.status !== 'confirmed' || attachment.kind !== 'unit_photo')
            throw ApiError.badRequest('只能关联已确认机器照片');
          await require('./stockEvidenceService').readAttachment(ctx.user, id);
          await db.StockAttachmentLink.findOrCreate({
            where: { attachmentId: id, unitId: unit.id },
            defaults: { createdBy: ctx.user.id, updatedBy: ctx.user.id },
            transaction: ctx.transaction,
          });
        }
      }
      unitIds.push(unit.id);
    }
    return { unitIds };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockUnitService', code: error.code || error.name });
    throw error;
  }
}
/** 来源明确解绑或补录。 */
async function setSource(ctx, id, input) {
  try {
    const unit = await getRow('StockUnit', id, ctx);
    assertVersion(unit, input.expectedVersion);
    if (input.orderId === undefined) throw ApiError.badRequest('orderId 必须明确提供');
    await bindSource(ctx, unit, input.orderId, input.bindingId ?? null);
    return { unitId: unit.id };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockUnitService', code: error.code || error.name });
    throw error;
  }
}
/** 成本纠正同时更新已售快照，不受普通目录变化影响。 */
async function setCost(ctx, id, input) {
  try {
    const unit = await getRow('StockUnit', id, ctx);
    assertVersion(unit, input.expectedVersion);
    if (unit.costStatus === 'confirmed') {
      requirePermissions(ctx, 'stock.correct');
      text(input.reason, '更正原因', 500);
    }
    const values = await costValues(ctx, unit.productId, input.acquiredOn, input);
    await updateRow(ctx, unit, values, 'cost');
    const items = await db.StockSaleUnit.findAll({
      where: { stockUnitId: unit.id, status: 'shipped' },
      transaction: ctx.transaction,
    });
    for (const item of items)
      await updateRow(ctx, item, { costAmountSnapshot: unit.officialCostAmount }, 'cost_snapshot');
    return { unitId: unit.id };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockUnitService', code: error.code || error.name });
    throw error;
  }
}
/** 当前生效成本版本期间检查。 */
async function validatePrice(ctx, values, id) {
  try {
    await activeRow(ctx, 'StockProduct', values.productId);
    dateOnly(values.validFrom);
    if (values.validTo) {
      dateOnly(values.validTo);
      if (values.validTo <= values.validFrom) throw ApiError.badRequest('结束日期必须晚于开始日期');
    }
    cents(values.amount, { positive: true });
    if (values.isActive === false) return;
    const existing = await db.StockOfficialPrice.findAll({
      where: { productId: values.productId, isActive: true },
      transaction: ctx.transaction,
    });
    if (
      existing.some(
        row =>
          row.id !== id &&
          (!row.validTo || row.validTo > values.validFrom) &&
          (!values.validTo || values.validTo > row.validFrom)
      )
    )
      throw ApiError.conflict('官网价有效区间重叠');
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockUnitService', code: error.code || error.name });
    throw error;
  }
}
/** 受控的基础资料维护。 */
async function saveCatalog(ctx, type, id, input) {
  try {
    requirePermissions(ctx, 'stock.catalog.manage');
    const models = {
      products: 'StockProduct',
      locations: 'StockLocation',
      parties: 'StockParty',
      prices: 'StockOfficialPrice',
    };
    const model = models[type];
    if (!model) throw ApiError.badRequest('资料类型无效');
    const current = id ? await getRow(model, id, ctx) : null;
    if (current) assertVersion(current, input.expectedVersion);
    const values = { ...(current?.toJSON() || {}), ...input };
    const data = { isActive: values.isActive !== false };
    if (typeof values.isActive !== 'boolean' && values.isActive !== undefined)
      throw ApiError.badRequest('启用状态须为布尔值');
    if (type === 'products') {
      for (const field of ['modelKey', 'modelName', 'colorKey', 'colorName'])
        data[field] = text(values[field], field, field === 'modelName' ? 100 : 64);
      if (!Number.isInteger(values.storageGb) || values.storageGb <= 0)
        throw ApiError.badRequest('容量必须为正整数');
      data.storageGb = values.storageGb;
      data.skuCode = text(values.skuCode, 'SKU', 64, true);
      if (
        current &&
        (await db.StockUnit.count({ where: { productId: id }, transaction: ctx.transaction })) &&
        ['modelKey', 'storageGb', 'colorKey'].some(k => data[k] !== current[k])
      )
        throw ApiError.conflict('已有实物引用的规格标识不能改写，请新建规格');
    } else if (type === 'locations') {
      if (current?.kind === 'historical') throw ApiError.badRequest('系统历史地点不可编辑');
      data.name = text(values.name, '位置名称', 100);
      data.city = text(values.city, '城市', 50, true) || '';
      data.kind = choice(values.kind, ['warehouse', 'consignee']);
      data.partyId =
        data.kind === 'consignee'
          ? (await activeRow(ctx, 'StockParty', values.partyId, 'consignee')).id
          : null;
      if (current && data.kind !== current.kind)
        throw ApiError.conflict('位置类型不可变更，请新建位置');
    } else if (type === 'parties') {
      data.name = text(values.name, '名称', 100);
      data.partyType = choice(values.partyType, ['internal_person', 'external_person', 'business']);
      data.roles = [
        ...new Set(
          array(values.roles, 4).map(role =>
            choice(role, ['customer', 'salesperson', 'consignee', 'handler'])
          )
        ),
      ];
      data.userId = values.userId || null;
      if (data.userId && !(await db.User.findByPk(data.userId, { transaction: ctx.transaction })))
        throw ApiError.badRequest('内部账号不存在');
      if (input.contact !== undefined)
        data.contactCiphertext = encrypt(text(input.contact, '联系方式', 500, true));
    } else {
      requirePermissions(ctx, 'stock.cost.edit');
      Object.assign(data, {
        productId: uuid(values.productId),
        validFrom: dateOnly(values.validFrom),
        validTo: values.validTo ? dateOnly(values.validTo) : null,
        amount: values.amount,
        sourceLabel: text(values.sourceLabel, '来源', 200),
        sourceVersion: text(values.sourceVersion, '价格版本', 100),
      });
      await validatePrice(ctx, data, id);
    }
    let row;
    if (current) row = await updateRow(ctx, current, data, 'catalog_update');
    else {
      row = await db[model].create(
        { ...data, createdBy: ctx.user.id, updatedBy: ctx.user.id },
        { transaction: ctx.transaction }
      );
      await recordEvent(ctx, model, row, 'catalog_create');
    }
    return { catalogType: type, id: row.id };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockUnitService', code: error.code || error.name });
    throw error;
  }
}
/** 管理员启用和设置期初时点。 */
async function saveSettings(ctx, input) {
  try {
    if (ctx.user.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', '管理员保留设置');
    const row = await getRow('StockSetting', 1, ctx);
    assertVersion(row, input.expectedVersion);
    const values = {};
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw ApiError.badRequest('enabled必须为布尔值');
      values.enabled = input.enabled;
    }
    if (input.cutoverAt !== undefined) {
      const date = input.cutoverAt === null ? null : instant(input.cutoverAt);
      if (
        +new Date(row.cutoverAt) !== +date &&
        ((await db.StockUnit.count({
          where: { state: { [Op.ne]: 'registered' } },
          transaction: ctx.transaction,
        })) ||
          (await db.StockImportJob.count({
            where: { status: 'committed' },
            transaction: ctx.transaction,
          })))
      )
        throw ApiError.conflict('已有业务后不能修改启用时点');
      values.cutoverAt = date;
    }
    await updateRow(ctx, row, values, 'settings');
    return { settingsId: 1 };
  } catch (error) {
    logger.debug('库存处理未完成', { module: 'stockUnitService', code: error.code || error.name });
    throw error;
  }
}
module.exports = {
  activeRow,
  costValues,
  ensureUnit,
  bindSource,
  receiveUnits,
  setSource,
  setCost,
  saveCatalog,
  saveSettings,
};
