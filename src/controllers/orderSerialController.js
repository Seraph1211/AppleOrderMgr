const { Op, UniqueConstraintError } = require('sequelize');
const db = require('../models');
const { scopeOrderWhere } = require('../services/orderAccessService');
const { normalizeDeviceBarcodes } = require('../services/pickupDeviceRules');
const {
  lockStock,
  legacyContext,
  updateRow,
  requirePermissions,
} = require('../services/stockCommandService');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/** 更正订单已绑定实物的序列号；主档、绑定及追加审计原子提交。 */
async function update(req, res) {
  try {
    const orderId = Number(req.params.orderId);
    const deviceId = req.params.deviceId;
    if (
      !Number.isSafeInteger(orderId) ||
      orderId <= 0 ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(deviceId || '')
    ) {
      throw ApiError.badRequest('订单或设备 ID 格式无效');
    }
    const values = normalizeDeviceBarcodes(req.body);
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const expected = req.body.expectedSerialNumber;
    if (
      !reason ||
      reason.length > 200 ||
      typeof expected !== 'string' ||
      !/^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(expected)
    ) {
      throw ApiError.badRequest('请提供原序列号及 1–200 字的修改原因');
    }
    const result = await db.sequelize.transaction(async transaction => {
      await lockStock(transaction);
      const ctx = await legacyContext(req.user, transaction, 'order.serial_update');
      requirePermissions(ctx, 'orders.read', 'orders.edit');
      const order = await db.Order.findOne({
        where: scopeOrderWhere(ctx.user, { id: orderId }),
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!order) throw ApiError.notFound('订单不存在或不可访问');
      const device = await db.PickupDevice.findOne({
        where: { id: deviceId, orderId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!device) throw ApiError.notFound('设备不存在或已解除绑定');
      if (device.serialNumber !== expected)
        throw ApiError.conflict(
          '序列号已被修改，请重新打开编辑后再试',
          undefined,
          'VERSION_CONFLICT'
        );
      if (device.serialNumber === values.serialNumber)
        return { device: { id: device.id, serialNumber: device.serialNumber }, changed: false };
      const unit = await db.StockUnit.findOne({
        where: device.stockUnitId ? { id: device.stockUnitId } : { serialNumber: expected },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!unit || unit.serialNumber !== expected)
        throw ApiError.conflict('设备主档与绑定不一致，请联系管理员核对');
      const duplicate = await db.StockUnit.findOne({
        where: { serialNumber: values.serialNumber, id: { [Op.ne]: unit.id } },
        transaction,
      });
      const binding = await db.PickupDevice.findOne({
        where: { serialNumber: values.serialNumber, id: { [Op.ne]: device.id } },
        transaction,
      });
      if (duplicate || binding)
        throw ApiError.conflict('该序列号已存在，请核对后重试', undefined, 'SN_EXISTS');
      const record = await db.PickupRecord.findOne({
        where: { orderId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!record) throw ApiError.conflict('取货记录缺失，请联系管理员核对');
      const before = { serialNumber: device.serialNumber, serialBarcode: device.serialBarcode };
      ctx.reason = reason;
      await updateRow(ctx, unit, { serialNumber: values.serialNumber }, 'order.serial_update');
      await device.update({ ...values, stockUnitId: unit.id }, { transaction });
      const beforeVersion = record.version;
      await record.update(
        { version: beforeVersion + 1, lastUpdatedBy: req.user.id },
        { transaction }
      );
      await db.PickupRecordEvent.create(
        {
          pickupRecordId: record.id,
          orderId,
          actorUserId: req.user.id,
          actorName: req.user.nickname || req.user.username,
          eventType: 'device_serial_updated',
          changes: {
            deviceId,
            stockUnitId: unit.id,
            before,
            after: values,
            reason,
            requestId: req.requestId,
            ip: String(req.ip || '').slice(0, 64),
          },
          beforeVersion,
          afterVersion: record.version,
        },
        { transaction }
      );
      return { device: { id: device.id, serialNumber: device.serialNumber }, changed: true };
    });
    req.auditTarget = `订单 ${orderId}；设备 ${deviceId}；序列号 ${expected} → ${values.serialNumber}；原因：${reason}`;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: result });
  } catch (error) {
    logger.warn('手动修改订单序列号失败', {
      userId: req.user?.id,
      orderId: req.params.orderId,
      requestId: req.requestId,
      code: error.code || error.name,
    });
    if (error instanceof UniqueConstraintError)
      throw ApiError.conflict('该序列号已存在，请核对后重试', undefined, 'SN_EXISTS');
    throw error;
  }
}

/** 删除误录的订单序列号绑定，保留实物主档和追加审计。 */
async function remove(req, res) {
  try {
    const orderId = Number(req.params.orderId);
    const deviceId = req.params.deviceId;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const expected = req.body?.expectedSerialNumber;
    if (
      !Number.isSafeInteger(orderId) ||
      orderId <= 0 ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(deviceId || '') ||
      typeof expected !== 'string' ||
      !/^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/.test(expected) ||
      !reason ||
      reason.length > 200
    ) {
      throw ApiError.badRequest('请提供有效订单、设备、原序列号及 1–200 字的删除原因');
    }
    const removed = await db.sequelize.transaction(async transaction => {
      await lockStock(transaction);
      const ctx = await legacyContext(req.user, transaction, 'order.serial_remove');
      requirePermissions(ctx, 'orders.read', 'orders.edit');
      const order = await db.Order.findOne({
        where: scopeOrderWhere(ctx.user, { id: orderId }),
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!order) throw ApiError.notFound('订单不存在或不可访问');
      const device = await db.PickupDevice.findOne({
        where: { id: deviceId, orderId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!device) return false;
      if (device.serialNumber !== expected)
        throw ApiError.conflict(
          '序列号已被修改，请重新打开详情后再试',
          undefined,
          'VERSION_CONFLICT'
        );
      const record = await db.PickupRecord.findOne({
        where: { orderId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const unit = await db.StockUnit.findOne({
        where: device.stockUnitId ? { id: device.stockUnitId } : { serialNumber: expected },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!record || !unit || unit.serialNumber !== expected)
        throw ApiError.conflict('设备记录不一致，请联系管理员核对');
      const beforeVersion = record.version;
      await record.update(
        { version: beforeVersion + 1, lastUpdatedBy: req.user.id },
        { transaction }
      );
      await db.PickupRecordEvent.create(
        {
          pickupRecordId: record.id,
          orderId,
          actorUserId: req.user.id,
          actorName: req.user.nickname || req.user.username,
          eventType: 'device_removed',
          changes: {
            device: device.toJSON(),
            reason,
            requestId: req.requestId,
            ip: String(req.ip || '').slice(0, 64),
          },
          beforeVersion,
          afterVersion: record.version,
        },
        { transaction }
      );
      ctx.reason = reason;
      await device.destroy({ transaction });
      await updateRow(ctx, unit, { orderNumberText: null }, 'order.serial_remove');
      return true;
    });
    req.auditTarget = `订单 ${orderId}；设备 ${deviceId}；删除序列号 ${expected}；原因：${reason}`;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: { removed } });
  } catch (error) {
    logger.warn('删除订单序列号失败', {
      userId: req.user?.id,
      orderId: req.params.orderId,
      requestId: req.requestId,
      code: error.code || error.name,
    });
    throw error;
  }
}

module.exports = { update, remove };
