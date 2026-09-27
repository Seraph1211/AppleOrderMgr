const { UniqueConstraintError } = require('sequelize');
const { sequelize, Order, PickupDevice, PickupRecord, PickupRecordEvent } = require('../models');
const { scopeOrderWhere } = require('../services/orderAccessService');
const { normalizeDeviceBarcodes } = require('../services/pickupDeviceRules');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

function parseOrderId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw ApiError.badRequest('订单 ID 必须是正整数');
  return id;
}

async function accessibleOrder(user, orderId, transaction) {
  try {
    const order = await Order.findOne({
      where: scopeOrderWhere(user, { id: orderId }),
      transaction,
      lock: transaction?.LOCK.UPDATE,
    });
    if (!order) throw ApiError.notFound('订单不存在或不可访问');
    return order;
  } catch (error) {
    logger.warn('校验设备订单范围失败', { userId: user?.id, code: error.code || error.name });
    throw error;
  }
}

function serialize(device) {
  return {
    id: device.id,
    orderId: device.orderId,
    serialNumber: device.serialNumber,
    scannedBy: device.scannedBy,
    createdAt: device.createdAt,
  };
}

function bindingConflict() {
  return ApiError.conflict(
    '该 Serial No. 已绑定其他订单，请核对包装盒或联系管理员',
    undefined,
    'DEVICE_ALREADY_BOUND'
  );
}

/** 读取明确订单的设备列表，同时校验订单范围。 */
async function list(req, res) {
  try {
    const orderId = parseOrderId(req.params.orderId);
    await accessibleOrder(req.user, orderId);
    const items = await PickupDevice.findAll({
      where: { orderId },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: { orderId, items: items.map(serialize) } });
  } catch (error) {
    logger.warn('读取取货设备失败', { userId: req.user?.id, code: error.code || error.name });
    throw error;
  }
}

/** 自动绑定设备序列号；事务、订单锁与唯一约束保证幂等及审计一致性。 */
async function create(req, res) {
  try {
    const orderId = parseOrderId(req.params.orderId);
    const values = normalizeDeviceBarcodes(req.body);
    const result = await sequelize.transaction(async transaction => {
      await accessibleOrder(req.user, orderId, transaction);
      const existing = await PickupDevice.findAll({
        where: { serialNumber: values.serialNumber },
        transaction,
      });
      if (existing.length) {
        const same =
          existing.length === 1 &&
          existing[0].orderId === orderId &&
          existing[0].serialNumber === values.serialNumber;
        if (!same) throw bindingConflict();
        return { device: serialize(existing[0]), alreadyBound: true };
      }
      let record = await PickupRecord.findOne({
        where: { orderId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!record) record = await PickupRecord.create({ orderId }, { transaction });
      const device = await PickupDevice.create(
        { ...values, orderId, scannedBy: req.user.id },
        { transaction }
      );
      const beforeVersion = record.version;
      await record.update(
        { version: beforeVersion + 1, lastUpdatedBy: req.user.id },
        { transaction }
      );
      await PickupRecordEvent.create(
        {
          pickupRecordId: record.id,
          orderId,
          actorUserId: req.user.id,
          actorName: req.user.nickname || req.user.username,
          eventType: 'device_added',
          changes: {
            device: { id: device.id, serialNumber: device.serialNumber },
          },
          beforeVersion,
          afterVersion: record.version,
        },
        { transaction }
      );
      return { device: serialize(device), alreadyBound: false };
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(result.alreadyBound ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    logger.warn('绑定取货设备失败', { userId: req.user?.id, code: error.code || error.name });
    if (error instanceof UniqueConstraintError) throw bindingConflict();
    throw error;
  }
}

/** 解除指定设备的活动绑定；保留原绑定审计，旧 UUID 重试不影响重新绑定。 */
async function remove(req, res) {
  try {
    const orderId = parseOrderId(req.params.orderId);
    const deviceId = req.params.deviceId;
    if (
      typeof deviceId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)
    ) {
      throw ApiError.badRequest('设备 ID 格式无效');
    }
    const removed = await sequelize.transaction(async transaction => {
      await accessibleOrder(req.user, orderId, transaction);
      const device = await PickupDevice.findOne({
        where: { id: deviceId, orderId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!device) return false;
      const record = await PickupRecord.findOne({
        where: { orderId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!record) throw ApiError.conflict('取货记录缺失，请刷新后重试');
      const beforeVersion = record.version;
      await record.update(
        { version: beforeVersion + 1, lastUpdatedBy: req.user.id },
        { transaction }
      );
      await PickupRecordEvent.create(
        {
          pickupRecordId: record.id,
          orderId,
          actorUserId: req.user.id,
          actorName: req.user.nickname || req.user.username,
          eventType: 'device_removed',
          changes: {
            device: {
              ...serialize(device),
              serialBarcode: device.serialBarcode,
              imei: device.imei,
              imeiBarcode: device.imeiBarcode,
            },
          },
          beforeVersion,
          afterVersion: record.version,
        },
        { transaction }
      );
      await device.destroy({ transaction });
      return true;
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: { removed } });
  } catch (error) {
    logger.warn('解除设备绑定失败', { userId: req.user?.id, code: error.code || error.name });
    throw error;
  }
}

module.exports = { list, create, remove };
