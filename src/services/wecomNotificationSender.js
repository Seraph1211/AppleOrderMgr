const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const { sequelize, WecomNotificationDelivery: Delivery, Order } = require('../models');
const { decrypt } = require('../utils/fieldEncryption');
const logger = require('../utils/logger');
const service = require('./wecomNotificationService');
const transport = require('./wecomTransport');
const paymentCode = require('./paymentCodeService');
const content = require('./wecomNotificationContent');
const SEND_INTERVAL_MS = 3334;
const LEASE_MS = 120000;
const TEST_MESSAGE = '企微新订单通知连接测试：此为合成测试消息，不包含真实订单或付款链接。';

async function claim(now) {
  try {
    return await service.transactionWork(async transaction => {
      const setting = await service.lockedSetting(transaction);
      await setting.update({ workerHeartbeatAt: now }, { transaction, silent: true });
      const expired = await Delivery.findAll({
        where: { status: 'sending', leaseUntil: { [Op.lte]: now } },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      for (const row of expired)
        await row.update(
          {
            status: row.dispatchStartedAt ? 'unknown' : 'pending',
            errorCode: row.dispatchStartedAt ? 'LEASE_UNKNOWN' : null,
            leaseToken: null,
            leaseUntil: null,
            version: row.version + 1,
          },
          { transaction }
        );
      if (
        !setting.webhookCipher ||
        setting.pausedReason ||
        +new Date(setting.nextSendAt || 0) > +now
      )
        return null;
      if (await Delivery.count({ where: { status: 'sending' }, transaction })) return null;
      const row = await Delivery.findOne({
        where: { status: { [Op.in]: service.ACTIVE_STATUSES } },
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!row || +new Date(row.notBefore) > +now) return null;
      if (!validScope(setting, row)) {
        await row.update(
          { status: 'skipped', errorCode: 'SCOPE_CHANGED', version: row.version + 1 },
          { transaction }
        );
        return null;
      }
      await row.update(
        {
          status: 'sending',
          leaseToken: randomUUID(),
          leaseUntil: new Date(+now + LEASE_MS),
          dispatchStartedAt: null,
          version: row.version + 1,
        },
        { transaction }
      );
      return row;
    });
  } catch (error) {
    logger.debug('企微通知事务未完成', { errorType: error.name });
    throw error;
  }
}
function validScope(setting, row) {
  return (
    setting.destinationId === row.destinationId &&
    (row.kind === 'test' ||
      (setting.enabled &&
        setting.enabledAt &&
        +new Date(row.createdAt) >= +new Date(setting.enabledAt)))
  );
}
async function updateClaim(row, values) {
  try {
    return await Delivery.update(
      { ...values, version: sequelize.literal('version + 1') },
      {
        where: {
          id: row.id,
          status: 'sending',
          leaseToken: row.leaseToken,
          dispatchStartedAt: null,
        },
      }
    );
  } catch (error) {
    logger.debug('企微通知事务未完成', { errorType: error.name });
    throw error;
  }
}
async function prepare(row, now) {
  try {
    if (row.kind === 'test') return { text: TEST_MESSAGE };
    const order = await Order.findByPk(row.orderId);
    const reason = content.orderBlockReason(order, now);
    if (reason)
      return { status: reason === 'DEADLINE_MISSING' ? 'failed' : 'skipped', errorCode: reason };
    let url = null;
    if (content.isWechat(order.paymentMethod)) {
      const code = await paymentCode.findOrderPaymentCode(order);
      url = content.decodePaymentQr(code?.payload?.imageDataUrl);
      if (!url && +now < +new Date(row.waitUntil))
        return {
          status: 'waiting',
          notBefore: new Date(Math.min(+now + 3000, +new Date(row.waitUntil))),
          errorCode: null,
        };
    }
    url ||= order.orderUrl;
    if (!url) return { status: 'failed', errorCode: 'LINK_MISSING' };
    const text = content.buildNotificationText(order, url);
    if (Buffer.byteLength(text, 'utf8') > content.MAX_TEXT_BYTES)
      return { status: 'failed', errorCode: 'TEXT_TOO_LONG' };
    return { text };
  } catch (error) {
    logger.debug('企微通知事务未完成', { errorType: error.name });
    throw error;
  }
}
// 临发前锁定配置与任务，再检查最新订单状态；不在事务内请求企微。
async function authorize(row, now) {
  try {
    return await service.transactionWork(async transaction => {
      const setting = await service.lockedSetting(transaction);
      const current = await Delivery.findByPk(row.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (
        current.status !== 'sending' ||
        current.leaseToken !== row.leaseToken ||
        +new Date(current.leaseUntil) <= +now
      )
        return null;
      let reason = !validScope(setting, current) ? 'SCOPE_CHANGED' : null;
      if (!reason && row.kind === 'order')
        reason = content.orderBlockReason(await Order.findByPk(row.orderId, { transaction }), now);
      if (reason) {
        await current.update(
          {
            status: reason === 'DEADLINE_MISSING' ? 'failed' : 'skipped',
            errorCode: reason,
            version: current.version + 1,
          },
          { transaction }
        );
        return null;
      }
      if (setting.pausedReason || +new Date(setting.nextSendAt || 0) > +now) {
        await current.update(
          { status: 'pending', leaseToken: null, leaseUntil: null, version: current.version + 1 },
          { transaction }
        );
        return null;
      }
      const webhook = decrypt(setting.webhookCipher);
      await setting.update(
        { nextSendAt: new Date(+now + SEND_INTERVAL_MS) },
        { transaction, silent: true }
      );
      await current.update(
        { dispatchStartedAt: now, attempts: current.attempts + 1, version: current.version + 1 },
        { transaction }
      );
      return { webhook, attempts: current.attempts, settingVersion: setting.version };
    });
  } catch (error) {
    logger.debug('企微通知事务未完成', { errorType: error.name });
    throw error;
  }
}
async function finish(row, authorization, result, now) {
  try {
    await service.transactionWork(async transaction => {
      const setting = await service.lockedSetting(transaction);
      const current = await Delivery.findByPk(row.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (current.status !== 'sending' || current.leaseToken !== row.leaseToken) return;
      let status = result.status;
      let errorCode = result.errorCode || null;
      if (status === 'pending' && !validScope(setting, current)) {
        status = 'skipped';
        errorCode = 'SCOPE_CHANGED';
      }
      if (status === 'pending' && authorization.attempts >= 3) status = 'failed';
      await current.update(
        {
          status,
          errorCode,
          sentAt: status === 'accepted' ? now : null,
          notBefore: new Date(+now + (result.retryMs || 0)),
          leaseToken: null,
          leaseUntil: null,
          version: current.version + 1,
        },
        { transaction }
      );
      if (
        result.pause &&
        setting.destinationId === row.destinationId &&
        setting.version === authorization.settingVersion
      )
        await setting.update({ pausedReason: errorCode }, { transaction, silent: true });
    });
  } catch (error) {
    logger.debug('企微通知事务未完成', { errorType: error.name });
    throw error;
  }
}
/** 处理队首一笔；正常调用官方传输，测试显式注入模拟传输与时钟。 @param {Object} options 测试依赖 @returns {Promise<boolean>} 是否有任务 */
async function sendNext(options = {}) {
  const clock = options.clock || (() => new Date());
  const send = options.send || transport.sendText;
  let row;
  try {
    row = await claim(clock());
    if (!row) return false;
    const prepared = await prepare(row, clock());
    if (!prepared.text) {
      await updateClaim(row, { ...prepared, leaseToken: null, leaseUntil: null });
      return true;
    }
    const authorization = await authorize(row, clock());
    if (!authorization) return true;
    let result;
    try {
      result = await send(authorization.webhook, prepared.text);
    } catch (_error) {
      result = { status: 'unknown', errorCode: 'TRANSPORT_UNKNOWN' };
    }
    await finish(row, authorization, result, clock());
    return true;
  } catch (error) {
    // 网络开始后的状态留给租约恢复为 unknown；未开始的安全重试也由租约恢复。
    logger.error('企微发送任务未完成', { deliveryId: row?.id || null, errorType: error.name });
    throw error;
  }
}
module.exports = { sendNext, TEST_MESSAGE };
