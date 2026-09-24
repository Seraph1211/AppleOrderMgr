const { AosRecord, Order, PaymentTask, PaymentTaskEvent, sequelize } = require('../models');
const { parseAosLine } = require('./aosParser');
const { getPaymentDeadline } = require('./paymentEligibility');
const { getSourcePaymentMethod, isAlipayPayment } = require('../utils/paymentMethod');
const repo = require('./ingestionRepository');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const ALIPAY_LINK_COLUMN_INDEX = 16;
const MAX_ALIPAY_LINK_LENGTH = 8192;
const ALIPAY_REQUIRED_PARAMS = [
  'app_id',
  'biz_content',
  'charset',
  'method',
  'notify_url',
  'return_url',
  'sign',
  'sign_type',
  'timestamp',
  'version',
];

function sourceContactEmail(orderUrl) {
  try {
    return decodeURIComponent(new URL(orderUrl).pathname.split('/').at(-1));
  } catch (_error) {
    return null;
  }
}

function parseBeijingTimestamp(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  return Date.parse(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`
  );
}

/**
 * 校验 AOS 第 17 列支付宝网关链接及订单身份，不访问该链接。
 * @param {string} value 原始链接
 * @param {string} orderNumber Apple 订单号
 * @param {string|Date} orderDate 来源下单时间
 * @returns {string} 原始签名链接
 */
function validateAlipayPaymentLink(value, orderNumber, orderDate) {
  const hasControlCharacter =
    typeof value === 'string' &&
    [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_ALIPAY_LINK_LENGTH ||
    /[\s\\]/.test(value) ||
    hasControlCharacter
  ) {
    throw new ApiError(409, 'ALIPAY_LINK_INVALID', '支付宝付款链接格式无效');
  }
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new ApiError(409, 'ALIPAY_LINK_INVALID', '支付宝付款链接格式无效');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'openapi.alipay.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/gateway.do' ||
    url.hash
  ) {
    throw new ApiError(409, 'ALIPAY_LINK_INVALID', '支付宝付款链接来源无效');
  }
  if (
    ALIPAY_REQUIRED_PARAMS.some(
      key => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)
    ) ||
    url.searchParams.get('method') !== 'alipay.trade.page.pay' ||
    url.searchParams.get('sign_type') !== 'RSA2' ||
    url.searchParams.get('charset')?.toLowerCase() !== 'utf-8'
  ) {
    throw new ApiError(409, 'ALIPAY_LINK_INVALID', '支付宝付款链接签名参数无效');
  }
  let business;
  try {
    business = JSON.parse(url.searchParams.get('biz_content'));
  } catch (_error) {
    throw new ApiError(409, 'ALIPAY_LINK_INVALID', '支付宝付款链接业务参数无效');
  }
  const sourceTime = new Date(orderDate).getTime();
  const linkTime = parseBeijingTimestamp(url.searchParams.get('timestamp'));
  if (
    !business ||
    typeof business !== 'object' ||
    Array.isArray(business) ||
    business.out_trade_no !== orderNumber ||
    !Number.isFinite(sourceTime) ||
    !Number.isFinite(linkTime) ||
    Math.abs(linkTime - sourceTime) > 5 * 60 * 1000
  ) {
    throw new ApiError(409, 'ALIPAY_LINK_IDENTITY_MISMATCH', '支付宝付款链接与订单身份不一致');
  }
  return value;
}

function assertOrderIdentity(order, parsed) {
  if (
    parsed.orderNumber !== order.orderNumber ||
    order.appleId?.toLowerCase() !== parsed.appleId?.toLowerCase() ||
    sourceContactEmail(order.orderUrl)?.toLowerCase() !== parsed.contactEmail?.toLowerCase() ||
    !order.orderDate ||
    repo.businessDate(order.orderDate) !== repo.businessDate(parsed.orderDate) ||
    !isAlipayPayment(getSourcePaymentMethod(order)) ||
    !isAlipayPayment(parsed.paymentMethod)
  ) {
    throw new ApiError(409, 'ALIPAY_LINK_IDENTITY_MISMATCH', '支付宝付款链接与订单身份不一致');
  }
}

/**
 * 从已关联的加密 AOS 订单原文中读取最新有效支付宝付款链接，不回写数据。
 * @param {Object} order 目标订单
 * @param {Object} [transaction] 调用方事务
 * @returns {Promise<string|null>} 支付宝付款链接
 */
async function findOrderAlipayPaymentLink(order, transaction) {
  try {
    if (!isAlipayPayment(getSourcePaymentMethod(order))) return null;
    const records = await AosRecord.findAll({
      where: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: ['succeeded', 'duplicate'],
      },
      attributes: ['id', 'payload', 'receivedAt', 'payloadHash'],
      order: [
        ['receivedAt', 'DESC'],
        ['payloadHash', 'DESC'],
        ['id', 'ASC'],
      ],
      transaction,
    });
    for (const record of records) {
      const rawLine = record.payload?.rawLine;
      if (typeof rawLine !== 'string') continue;
      const parsed = parseAosLine(rawLine);
      const value = rawLine.split('\t')[ALIPAY_LINK_COLUMN_INDEX];
      try {
        if (parsed.issues.length) continue;
        assertOrderIdentity(order, parsed.data);
        return validateAlipayPaymentLink(value, order.orderNumber, parsed.data.orderDate);
      } catch (error) {
        if (!error.statusCode) throw error;
        logger.debug('订单来源支付宝付款链接校验未通过', {
          orderId: order.id,
          recordId: record.id,
          errorCode: error.code,
        });
      }
    }
    return null;
  } catch (error) {
    logger.debug('支付宝付款链接读取未完成', {
      orderId: order.id,
      errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
    });
    throw error;
  }
}

/**
 * 按调度或本人付款任务范围读取支付宝付款链接并记录访问事件。
 * @param {number} taskId 付款任务 ID
 * @param {number} actorUserId 操作人 ID
 * @param {boolean} own 是否限制为操作人当前任务
 * @returns {Promise<Object>} 支付宝付款链接与时间
 */
async function getTaskAlipayPaymentLink(taskId, actorUserId, own) {
  if (!Number.isSafeInteger(taskId) || taskId <= 0 || taskId > 2147483647) {
    throw ApiError.badRequest('任务 ID 必须是有效正整数');
  }
  try {
    return await sequelize.transaction(async transaction => {
      let task;
      if (own) {
        task = await PaymentTask.findOne({
          where: { id: taskId, assigneeUserId: actorUserId },
          transaction,
          lock: transaction.LOCK.SHARE,
        });
      } else {
        task = await PaymentTask.findByPk(taskId, {
          transaction,
          lock: transaction.LOCK.SHARE,
        });
      }
      if (!task) {
        throw ApiError.notFound(own ? '付款任务不存在或已转派' : '付款任务不存在');
      }
      const order = await Order.findByPk(task.orderId, { transaction });
      if (!order) throw ApiError.notFound('订单不存在');
      if (!isAlipayPayment(getSourcePaymentMethod(order))) {
        throw new ApiError(400, 'ALIPAY_PAYMENT_METHOD_REQUIRED', '该订单不是支付宝支付');
      }
      const paymentUrl = await findOrderAlipayPaymentLink(order, transaction);
      if (!paymentUrl) {
        throw new ApiError(404, 'ALIPAY_PAYMENT_LINK_MISSING', '支付宝付款链接不存在或校验未通过');
      }
      const now = new Date();
      await PaymentTaskEvent.create(
        {
          paymentTaskId: task.id,
          eventType: 'payment_link_accessed',
          actorUserId,
          beforeStatus: task.processingStatus,
          afterStatus: task.processingStatus,
          details: {
            accessedAt: now.toISOString(),
            source: own ? 'payment_tasks' : 'payment_dispatch',
            linkType: 'aos_alipay',
          },
        },
        { transaction }
      );
      return {
        paymentUrl,
        serverTime: now,
        deadlineAt: getPaymentDeadline(order),
      };
    });
  } catch (error) {
    logger.debug('支付宝付款链接读取未完成', {
      taskId,
      actorUserId,
      errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
    });
    throw error;
  }
}

/**
 * 按付款调度权限读取支付宝付款链接。
 * @param {number} taskId 付款任务 ID
 * @param {number} actorUserId 操作人 ID
 * @returns {Promise<Object>} 支付宝付款链接与时间
 */
function getDispatchAlipayPaymentLink(taskId, actorUserId) {
  return getTaskAlipayPaymentLink(taskId, actorUserId, false);
}

/**
 * 按本人付款任务当前归属读取支付宝付款链接。
 * @param {number} taskId 付款任务 ID
 * @param {number} actorUserId 操作人 ID
 * @returns {Promise<Object>} 支付宝付款链接与时间
 */
function getOwnAlipayPaymentLink(taskId, actorUserId) {
  return getTaskAlipayPaymentLink(taskId, actorUserId, true);
}

module.exports = {
  validateAlipayPaymentLink,
  findOrderAlipayPaymentLink,
  getDispatchAlipayPaymentLink,
  getOwnAlipayPaymentLink,
};
