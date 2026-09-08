const { sequelize, Order, OrderPayerEvent } = require('../models');
const ApiError = require('../utils/ApiError');

/**
 * 规范化外部付款人姓名。
 * @param {string|null} value - 原始付款人姓名
 * @returns {string|null} 规范化结果
 */
function normalizePayerName(value) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw ApiError.badRequest('payerName 必须是字符串或 null');
  }
  const payerName = value.trim();
  if (payerName.length > 100) {
    throw ApiError.badRequest('payerName 不能超过 100 个字符');
  }
  return payerName || null;
}

/**
 * 在调用方事务内更新已锁定订单的付款人并写入审计。
 * @param {Object} order - 已使用 FOR UPDATE 锁定的订单模型
 * @param {Object} input - 付款人更新参数
 * @param {string|null} input.payerName - 外部付款人姓名
 * @param {number} input.expectedVersion - 当前付款人版本
 * @param {string} input.idempotencyKey - 幂等键
 * @param {string} [input.reason] - 可选更正说明
 * @param {number} actorUserId - 操作员工 ID
 * @param {Object} transaction - Sequelize 事务
 * @returns {Promise<Object>} 更新结果
 */
async function updateLockedOrderPayer(order, input, actorUserId, transaction) {
  const expectedVersion = Number(input.expectedVersion);
  const payerName = normalizePayerName(input.payerName);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw ApiError.badRequest('expectedVersion 必须是非负整数');
  }
  if (order.payerVersion !== expectedVersion) {
    throw ApiError.conflict(
      '付款人登记已被更新',
      { currentVersion: order.payerVersion },
      'CONCURRENT_MODIFICATION'
    );
  }

  const previousPayerName = order.payerName;
  if (previousPayerName === payerName) {
    return {
      orderId: order.id,
      payerName,
      payerVersion: order.payerVersion,
      changed: false,
    };
  }

  order.payerName = payerName;
  order.payerVersion += 1;
  await order.save({ transaction });
  await OrderPayerEvent.create(
    {
      orderId: order.id,
      previousPayerName,
      newPayerName: payerName,
      actorUserId,
      reason: input.reason ? String(input.reason).trim().slice(0, 500) : null,
      beforeVersion: expectedVersion,
      afterVersion: order.payerVersion,
      idempotencyKey: input.idempotencyKey,
    },
    { transaction }
  );
  return {
    orderId: order.id,
    payerName,
    payerVersion: order.payerVersion,
    changed: true,
  };
}

/**
 * 原子登记订单的外部付款人姓名并追加审计事件。
 * 付款人不是系统账号，也不建立可登录的付款人主数据。
 * @param {number} orderId - 订单 ID
 * @param {Object} input - 登记参数
 * @param {string|null} input.payerName - 外部付款人姓名
 * @param {number} input.expectedVersion - 当前付款人版本
 * @param {string} input.idempotencyKey - 幂等键
 * @param {string} [input.reason] - 可选更正说明
 * @param {number} actorUserId - 操作员工 ID
 * @param {Object} [scope] - 任务所有权限制
 * @param {number} [scope.assigneeUserId] - 若存在，要求订单任务属于该员工
 * @returns {Promise<Object>} 登记结果
 */
async function assignOrderPayer(orderId, input, actorUserId, scope = {}) {
  const expectedVersion = Number(input.expectedVersion);
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const payerName = normalizePayerName(input.payerName);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw ApiError.badRequest('expectedVersion 必须是非负整数');
  }
  if (!idempotencyKey || idempotencyKey.length > 100) {
    throw ApiError.badRequest('idempotencyKey 长度必须在 1-100 之间');
  }

  return await sequelize.transaction(async transaction => {
    const replay = await OrderPayerEvent.findOne({
      where: { actorUserId, idempotencyKey },
      transaction,
    });
    if (replay) {
      if (replay.orderId !== orderId) {
        throw ApiError.conflict('幂等键已用于其他订单', undefined, 'IDEMPOTENCY_CONFLICT');
      }
      const order = await Order.findByPk(replay.orderId, { transaction });
      return {
        orderId: order.id,
        payerName: order.payerName,
        payerVersion: order.payerVersion,
        replayed: true,
      };
    }

    const scopedTaskInclude = [];
    if (scope.assigneeUserId) {
      scopedTaskInclude.push({
        association: 'paymentTask',
        attributes: ['id', 'assigneeUserId'],
        required: true,
        where: { assigneeUserId: scope.assigneeUserId },
      });
    }
    const order = await Order.findByPk(orderId, {
      include: scopedTaskInclude,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) throw ApiError.notFound('订单不存在或不属于当前用户');
    const result = await updateLockedOrderPayer(
      order,
      { ...input, payerName, expectedVersion, idempotencyKey },
      actorUserId,
      transaction
    );
    return { ...result, replayed: false };
  });
}

module.exports = { assignOrderPayer, normalizePayerName, updateLockedOrderPayer };
