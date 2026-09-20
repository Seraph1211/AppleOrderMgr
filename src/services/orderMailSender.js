const nodemailer = require('nodemailer');
const { Op } = require('sequelize');
const { sequelize, OrderMailDelivery } = require('../models');
const { getOrderMailConfig, isOrderMailConfigured } = require('./orderMailConfig');
const { currentActor, accessibleMessage } = require('./orderMailService');
const { parseOrderMail } = require('./orderMailContent');
const { buildForwardMessage } = require('./orderMailForward');
const logger = require('../utils/logger');

const SEND_LEASE_MS = 5 * 60000;
const MAX_ATTEMPTS = 3;

/** SMTP明确拒绝与结果不明分开，避免超时后重复发信。 */
function classifySendFailure(error, attempts) {
  if (error.code === 'EAUTH') return { status: 'failed', errorCode: 'SMTP_AUTH' };
  if (Number(error.responseCode) >= 400 && Number(error.responseCode) < 500)
    return {
      status: attempts < MAX_ATTEMPTS ? 'retry_wait' : 'failed',
      errorCode: 'SMTP_TEMPORARY',
    };
  if (Number(error.responseCode) >= 500 && Number(error.responseCode) < 600)
    return { status: 'failed', errorCode: 'SMTP_REJECTED' };
  return { status: 'unknown', errorCode: 'SEND_UNKNOWN' };
}

/** 原子领取发送任务；过期的在途任务不能被自动重发。 */
async function claimDelivery() {
  try {
    await OrderMailDelivery.update(
      { status: 'unknown', errorCode: 'SEND_UNKNOWN' },
      {
        where: { status: 'sending', startedAt: { [Op.lt]: new Date(Date.now() - SEND_LEASE_MS) } },
      }
    );
    return await sequelize.transaction(async transaction => {
      const delivery = await OrderMailDelivery.findOne({
        where: {
          status: { [Op.in]: ['queued', 'retry_wait'] },
          notBefore: { [Op.lte]: new Date() },
        },
        order: [
          ['notBefore', 'ASC'],
          ['createdAt', 'ASC'],
        ],
        transaction,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
      });
      if (!delivery) return null;
      await delivery.update(
        {
          status: 'sending',
          startedAt: new Date(),
          attempts: delivery.attempts + 1,
          errorCode: null,
        },
        { transaction }
      );
      return delivery;
    });
  } catch (error) {
    logger.warn('订单邮件操作未完成', { errorType: error.name, errorCode: error.code });
    throw error;
  }
}

/** 发送一个队列任务，可注入传输实现用于无真实发信的验证。 */
async function sendNextOrderMail({ transport, config = getOrderMailConfig() } = {}) {
  let delivery;
  let smtpStarted = false;
  let client;
  try {
    if (!isOrderMailConfigured(config)) return false;
    delivery = await claimDelivery();
    if (!delivery) return false;
    const actor = await currentActor(delivery.actorUserId);
    const message = await accessibleMessage(actor, delivery.orderId, delivery.messageId, {
      content: true,
    });
    const raw = Buffer.from(message.rawContent, 'base64');
    const parsed = await parseOrderMail(raw);
    // 解析后再次验证，撤权或订单TAG变化不能沿用排队时范围。
    await accessibleMessage(
      await currentActor(delivery.actorUserId),
      delivery.orderId,
      delivery.messageId,
      { content: true }
    );
    client = transport || nodemailer.createTransport(config.smtp);
    smtpStarted = true;
    const result = await client.sendMail(buildForwardMessage(delivery, parsed, raw, config));
    if (
      !result.accepted?.some(
        address => String(address).toLowerCase() === delivery.payload.recipient.toLowerCase()
      )
    )
      throw Object.assign(new Error('邮件服务器未接受目标地址'), { responseCode: 550 });
    await delivery.update({ status: 'accepted', sentAt: new Date(), errorCode: null });
    return true;
  } catch (error) {
    if (!delivery) throw error;
    let outcome;
    if (smtpStarted) {
      outcome = classifySendFailure(error, delivery.attempts);
    } else if ([403, 404, 410].includes(error.statusCode)) {
      outcome = {
        status: 'cancelled',
        errorCode: error.statusCode === 410 ? 'ORDER_MAIL_EXPIRED' : 'ACCESS_REVOKED',
      };
    } else {
      outcome = {
        status: delivery.attempts < MAX_ATTEMPTS ? 'retry_wait' : 'failed',
        errorCode: 'PREPARE_TEMPORARY',
      };
    }
    try {
      await delivery.update({
        ...outcome,
        notBefore: new Date(Date.now() + delivery.attempts * 60000),
      });
    } catch (_persistError) {
      // 已发信但无法写结果时保持sending，由租约恢复为unknown，不重发。
      logger.error('订单邮件发送结果未能持久化', { deliveryId: delivery.id });
    }
    logger.warn('订单邮件发送未完成', { deliveryId: delivery.id, errorCode: outcome.errorCode });
    return true;
  } finally {
    if (!transport) client?.close();
  }
}

module.exports = { buildForwardMessage, classifySendFailure, claimDelivery, sendNextOrderMail };
