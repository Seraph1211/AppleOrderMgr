const crypto = require('crypto');
const { Order, OrderPaymentCode, PaymentTask, PaymentTaskEvent, sequelize } = require('../models');
const repo = require('./ingestionRepository');
const { validatePaymentPng } = require('./paymentCodeValidation');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

function validateRecord(input) {
  repo.assertFields(input, [
    'eventId',
    'orderNumber',
    'orderDate',
    'sourceTime',
    'contactEmail',
    'appleId',
    'paymentMethod',
    'imageDataUrl',
  ]);
  repo.requireUuid(input.eventId);
  if (!/^W\d{10}$/.test(input.orderNumber) || input.paymentMethod !== '微信')
    throw ApiError.badRequest('付款码订单或支付方式无效');
  for (const key of ['orderDate', 'sourceTime']) {
    if (
      typeof input[key] !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input[key]) ||
      !Number.isFinite(Date.parse(input[key]))
    )
      throw ApiError.badRequest('付款码时间无效');
  }
  const delta = Date.parse(input.sourceTime) - Date.parse(input.orderDate);
  if (delta < -300000 || delta > 86400000 || Date.parse(input.sourceTime) > Date.now() + 300000)
    throw ApiError.badRequest('付款码来源时间超出范围');
  for (const key of ['contactEmail', 'appleId']) {
    if (
      typeof input[key] !== 'string' ||
      input[key].length > 255 ||
      !/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(input[key])
    )
      throw ApiError.badRequest('付款码关联字段无效');
  }
  return validatePaymentPng(input.imageDataUrl);
}
/** 接收已关联的付款码；旧订单不受当天补单范围限制，绝不创建订单。 @param {string} header 凭据 @param {Object} body 请求 @returns {Promise<Object>} 回执 */
async function receivePaymentCodes(header, body) {
  try {
    repo.assertFields(body, ['records']);
    if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 20)
      throw ApiError.badRequest('每批限 1–20 个付款码');
    const results = [];
    for (const input of body.records) {
      try {
        const imageHash = validateRecord(input);
        const payloadHash = repo.payloadHash(input);
        results.push(
          await repo.ingestionTransaction(async (transaction, settings) => {
            try {
              const device = await repo.authenticateDevice(header, transaction);
              const previous = await OrderPaymentCode.findOne({
                where: { deviceId: device.id, eventId: input.eventId },
                transaction,
              });
              if (previous) {
                if (previous.payloadHash !== payloadHash)
                  throw ApiError.conflict(
                    '事件载荷与首次提交不同',
                    undefined,
                    'EVENT_PAYLOAD_CONFLICT'
                  );
                return {
                  eventId: input.eventId,
                  receiptStatus: 'already_received',
                  recordId: previous.id,
                };
              }
              if (settings.activeSource !== 'aos')
                throw new ApiError(409, 'SOURCE_DISABLED', 'AOS 来源暂停');
              const order = await Order.findOne({
                where: { orderNumber: input.orderNumber },
                transaction,
                lock: transaction.LOCK.UPDATE,
              });
              if (!order) throw new ApiError(409, 'ORDER_NOT_READY', '等待订单入库');
              let contactEmail;
              try {
                contactEmail = decodeURIComponent(
                  new URL(order.orderUrl).pathname.split('/').at(-1)
                );
              } catch (_error) {
                contactEmail = null;
              }
              if (
                order.appleId?.toLowerCase() !== input.appleId.toLowerCase() ||
                contactEmail?.toLowerCase() !== input.contactEmail.toLowerCase() ||
                !order.orderDate ||
                repo.businessDate(order.orderDate) !== repo.businessDate(input.orderDate) ||
                !['微信', '微信支付', 'wechat', 'wechat pay'].includes(
                  (order.paymentMethod || '').toLowerCase()
                )
              ) {
                throw new ApiError(409, 'PAYMENT_CODE_IDENTITY_MISMATCH', '付款码与订单身份不一致');
              }
              const row = await OrderPaymentCode.create(
                {
                  id: crypto.randomUUID(),
                  deviceId: device.id,
                  eventId: input.eventId,
                  orderId: order.id,
                  orderNumber: order.orderNumber,
                  sourceTime: input.sourceTime,
                  imageHash,
                  payloadHash,
                  payload: input,
                },
                { transaction }
              );
              return { eventId: input.eventId, receiptStatus: 'accepted', recordId: row.id };
            } catch (error) {
              logger.debug('付款码或采集更新操作未完成', {
                errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
              });
              throw error;
            }
          })
        );
      } catch (error) {
        const retryable =
          !error.statusCode ||
          ['ORDER_NOT_READY', 'SOURCE_DISABLED', 'DEVICE_DISABLED'].includes(error.code);
        results.push({
          eventId: input?.eventId,
          receiptStatus: 'rejected',
          errorCode: error.statusCode ? error.code : 'TEMPORARILY_UNAVAILABLE',
          retryable,
        });
        logger.debug('付款码接收未完成', { errorCode: error.code || 'TEMPORARILY_UNAVAILABLE' });
      }
    }
    return { results };
  } catch (error) {
    logger.debug('付款码或采集更新操作未完成', {
      errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
    });
    throw error;
  }
}
/** 读取任务付款码，并在同一事务核对当前归属与记录访问。 @param {number} id 任务 @param {number} userId 用户 @param {boolean} own 仅本人 @returns {Promise<Object>} 安全响应 */
async function getPaymentCode(id, userId, own = true) {
  try {
    if (!Number.isSafeInteger(id) || id < 1) throw ApiError.badRequest('任务 ID 无效');
    return await sequelize.transaction(async transaction => {
      try {
        const task = await PaymentTask.findOne({
          where: { id, ...(own ? { assigneeUserId: userId } : {}) },
          transaction,
          lock: transaction.LOCK.SHARE,
        });
        if (!task) throw ApiError.notFound('付款任务不存在或已转派');
        const order = await Order.findByPk(task.orderId, { transaction });
        if (!order) throw ApiError.notFound('订单不存在');
        await PaymentTaskEvent.create(
          {
            paymentTaskId: id,
            eventType: 'payment_code_accessed',
            actorUserId: userId,
            beforeStatus: task.processingStatus,
            afterStatus: task.processingStatus,
            details: {},
          },
          { transaction }
        );
        if (['支付宝', 'alipay'].includes((order.paymentMethod || '').trim().toLowerCase()))
          return { availability: 'unsupported', message: '支付宝暂无法获取付款码' };
        const row = await OrderPaymentCode.findOne({
          where: { orderId: order.id },
          order: [
            ['sourceTime', 'DESC'],
            ['imageHash', 'DESC'],
            ['id', 'ASC'],
          ],
          transaction,
        });
        return {
          availability: row ? 'available' : 'missing',
          message: row ? null : '暂未采集到付款码，请稍后重试',
          orderId: order.id,
          orderNumber: order.orderNumber,
          products: order.products,
          amount: order.officialOrderAmount,
          paymentMethod: order.paymentMethod,
          officialOrderStatus: order.status,
          officialPaymentStatus: order.paymentStatus,
          deadlineAt: task.deadlineAt,
          imageDataUrl: row?.payload.imageDataUrl || null,
          sourceTime: row?.sourceTime || null,
        };
      } catch (error) {
        logger.debug('付款码或采集更新操作未完成', {
          errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
        });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('付款码或采集更新操作未完成', {
      errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
    });
    throw error;
  }
}
module.exports = { receivePaymentCodes, getPaymentCode };
