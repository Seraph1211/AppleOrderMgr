/**
 * 订单服务
 * @description 处理订单相关的数据库操作，包括创建订单、更新订单、关联 Apple ID 和收件人
 * @author Seraph
 * @date 2026-07-07
 */

const { sequelize, Sequelize, Order, EmailLog, AppleId, Recipient } = require('../models');
const logger = require('../utils/logger');
const { isValidOrderNumber, isValidEmail } = require('../utils/helpers');
const { EMAIL_ERROR_CODES, EmailProcessingError } = require('./emailErrors');
const { createOrderInTransaction } = require('./orderIngestionCore');
const ingestionRepo = require('./ingestionRepository');
const { OrderSource } = require('../models');
const crypto = require('crypto');

/**
 * 从邮件数据保存订单
 * @param {Object} emailData - 解析后的邮件数据
 * @param {string} emailUid - 邮件唯一标识符
 * @param {Object} [options] - 持久化选项
 * @param {number} [options.emailLogId] - 已接收邮件记录 ID
 * @param {number} [options.expectedVersion] - 人工处理乐观锁版本
 * @param {number} [options.resolvedBy] - 人工处理用户 ID
 * @returns {Promise<Object>} 创建的订单对象
 */
async function saveOrderFromEmail(emailData, emailUid, options = {}) {
  const transaction = await sequelize.transaction();

  try {
    const ingestionSettings = await ingestionRepo.lockSettings(transaction);
    let emailLog = null;
    if (options.emailLogId) {
      emailLog = await EmailLog.findByPk(options.emailLogId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!emailLog) {
        throw new EmailProcessingError(EMAIL_ERROR_CODES.INVALID_STATE, '邮件处理记录不存在');
      }
      if (
        options.expectedVersion !== undefined &&
        Number(options.expectedVersion) !== emailLog.version
      ) {
        throw new EmailProcessingError(
          EMAIL_ERROR_CODES.CONCURRENT_MODIFICATION,
          '邮件处理记录已被其他操作更新'
        );
      }
      if (['succeeded', 'superseded', 'ignored'].includes(emailLog.status)) {
        throw new EmailProcessingError(EMAIL_ERROR_CODES.INVALID_STATE, '邮件记录已经终态处理');
      }
      emailLog.status = 'processing';
      emailLog.lastAttemptAt = new Date();
      await emailLog.save({ transaction });
    }

    logger.info('开始保存订单', {
      emailRecordId: options.emailLogId || null,
    });

    // 1. 验证订单号格式
    if (!isValidOrderNumber(emailData.orderNumber)) {
      throw new EmailProcessingError(EMAIL_ERROR_CODES.ORDER_NUMBER_INVALID, '订单号格式无效');
    }

    // 2. 验证 Apple ID 格式
    if (!isValidEmail(emailData.appleId)) {
      throw new EmailProcessingError(EMAIL_ERROR_CODES.APPLE_ID_INVALID, 'Apple ID 格式无效');
    }

    if (emailLog && options.expectedVersion !== undefined) {
      const originalDate = emailLog.manualDraft?.orderDate || emailLog.parsedData?.orderDate;
      if (
        !originalDate ||
        ingestionRepo.businessDate(originalDate) !== ingestionRepo.businessDate(emailData.orderDate)
      )
        emailLog.ingestionEligibleAt = null;
    }
    ingestionRepo.requireAllowed(
      ingestionRepo.eligibility(ingestionSettings, 'email', {
        orderDate: emailData.orderDate,
        ingestionEligibleAt: emailLog?.ingestionEligibleAt,
      })
    );
    if (emailLog) {
      emailLog.ingestionEligibleAt ||= new Date();
      emailLog.ingestionPauseReason = null;
    }

    // 相同订单号的并发邮件在 PostgreSQL 事务内串行化，避免先查后建竞争。
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:orderNumber))', {
      replacements: { orderNumber: emailData.orderNumber },
      type: Sequelize.QueryTypes.SELECT,
      transaction,
    });

    // 3. 检查订单是否已存在
    const existingOrder = await Order.findOne({
      where: { orderNumber: emailData.orderNumber },
      transaction,
    });

    if (existingOrder) {
      logger.warn('订单已存在，跳过创建', {
        emailRecordId: options.emailLogId || null,
        existingOrderId: existingOrder.id,
      });

      if (emailLog) {
        emailLog.status = 'superseded';
        emailLog.processed = true;
        emailLog.processedAt = new Date();
        emailLog.success = true;
        emailLog.orderId = existingOrder.id;
        emailLog.orderNumber = existingOrder.orderNumber;
        emailLog.finalData = emailData;
        emailLog.errorCode = null;
        emailLog.errorMessage = null;
        emailLog.resolvedAt = new Date();
        emailLog.resolutionType = 'existing_order';
        emailLog.resolvedBy = options.resolvedBy || null;
        emailLog.attemptHistory = [
          ...(emailLog.attemptHistory || []),
          {
            at: new Date().toISOString(),
            event: 'attempt_superseded',
            retryCount: emailLog.retryCount,
          },
        ];
        emailLog.version += 1;
        await emailLog.save({ transaction });
      } else {
        emailLog = await createEmailLog(emailUid, emailData, true, existingOrder.id, transaction);
        await emailLog.update(
          { status: 'superseded', resolutionType: 'existing_order', resolvedAt: new Date() },
          { transaction }
        );
      }

      await OrderSource.findOrCreate({
        where: { emailLogId: emailLog.id },
        defaults: {
          id: crypto.randomUUID(),
          orderId: existingOrder.id,
          source: 'email',
          result: 'duplicate',
          receivedAt: emailLog.receivedAt || new Date(),
        },
        transaction,
      });
      await transaction.commit();
      return existingOrder;
    }

    const order = await createOrderInTransaction(emailData, transaction, {
      ...options,
      source: 'email',
    });

    // 7. 更新邮件处理记录；兼容旧调用时才创建日志。
    if (emailLog) {
      emailLog.status = 'succeeded';
      emailLog.processed = true;
      emailLog.processedAt = new Date();
      emailLog.success = true;
      emailLog.orderId = order.id;
      emailLog.orderNumber = order.orderNumber;
      emailLog.finalData = emailData;
      emailLog.errorCode = null;
      emailLog.errorMessage = null;
      emailLog.nextRetryAt = null;
      emailLog.resolvedAt = new Date();
      emailLog.resolutionType = options.resolvedBy ? 'manual_ingest' : 'automatic_ingest';
      emailLog.resolvedBy = options.resolvedBy || null;
      emailLog.attemptHistory = [
        ...(emailLog.attemptHistory || []),
        {
          at: new Date().toISOString(),
          event: 'attempt_succeeded',
          retryCount: emailLog.retryCount,
        },
      ];
      emailLog.version += 1;
      await emailLog.save({ transaction });
    } else {
      emailLog = await createEmailLog(emailUid, emailData, true, order.id, transaction);
    }

    await OrderSource.create(
      {
        id: crypto.randomUUID(),
        orderId: order.id,
        source: 'email',
        emailLogId: emailLog.id,
        result: 'created',
        receivedAt: emailLog.receivedAt || new Date(),
      },
      { transaction }
    );
    // 8. 提交事务
    await transaction.commit();

    logger.info('✅ 订单保存完成', {
      emailRecordId: options.emailLogId || null,
      orderId: order.id,
    });

    return order;
  } catch (error) {
    // 回滚事务
    await transaction.rollback();

    logger.error('订单保存失败', {
      emailRecordId: options.emailLogId || null,
      errorCode: error.code || EMAIL_ERROR_CODES.UNKNOWN,
    });

    // 记录失败的邮件日志
    if (!options.emailLogId && !['SOURCE_DISABLED', 'RECORD_OUT_OF_RANGE'].includes(error.code)) {
      try {
        await createEmailLog(emailUid, emailData, false, null, null, '邮件处理失败');
      } catch (logError) {
        logger.error('记录邮件日志失败', {
          errorCode: logError.code || EMAIL_ERROR_CODES.DATABASE_TEMPORARY,
        });
      }
    }

    throw error;
  }
}

/**
 * 创建邮件日志
 * @param {string} emailUid - 邮件唯一标识符
 * @param {Object} emailData - 邮件数据
 * @param {boolean} success - 处理是否成功
 * @param {number|null} orderId - 订单ID（可选）
 * @param {Object|null} transaction - 数据库事务
 * @param {string|null} errorMessage - 错误信息（可选）
 * @returns {Promise<Object>} 创建的邮件日志对象
 */
async function createEmailLog(
  emailUid,
  emailData,
  success,
  orderId = null,
  transaction = null,
  errorMessage = null
) {
  let parsedData = null;
  if (success) {
    parsedData = {
      appleId: emailData.appleId,
      orderNumber: emailData.orderNumber,
      orderDate: emailData.orderDate,
      products: emailData.products,
      recipient: emailData.recipient,
      paymentMethod: emailData.paymentMethod,
    };
  }
  const logData = {
    emailUid: emailUid,
    emailSubject: emailData.emailSubject || '',
    emailFrom: emailData.emailFrom || '',
    emailDate: emailData.emailDate || new Date(),
    source: 'imap',
    rawContent: emailData.rawContent || null, // Base64 编码的原始邮件
    processed: true,
    processedAt: new Date(),
    success: success,
    errorMessage: errorMessage || null,
    parsedData,
    orderNumber: emailData.orderNumber || null,
    retryCount: 0,
    status: success ? 'succeeded' : 'manual_review',
    errorCode: success ? null : EMAIL_ERROR_CODES.UNKNOWN,
    orderId,
    receivedAt: new Date(),
    retentionExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    imapAckStatus: 'not_required',
  };

  if (transaction) {
    return await EmailLog.create(logData, { transaction });
  } else {
    return await EmailLog.create(logData);
  }
}

/**
 * 根据订单号查询订单
 * @param {string} orderNumber - 订单号
 * @returns {Promise<Object|null>} 订单对象
 */
async function getOrderByNumber(orderNumber) {
  try {
    const order = await Order.findOne({
      where: { orderNumber },
      include: [
        { model: AppleId, as: 'appleAccount' },
        { model: Recipient, as: 'recipient' },
      ],
    });

    return order;
  } catch (error) {
    logger.error('查询订单失败', {
      orderNumber,
      error: error.message,
    });
    throw error;
  }
}

/**
 * 更新订单状态
 * @param {string} orderNumber - 订单号
 * @param {string} status - 新状态
 * @returns {Promise<boolean>} 是否更新成功
 */
async function updateOrderStatus(orderNumber, status) {
  try {
    const [updatedCount] = await Order.update({ status }, { where: { orderNumber } });

    if (updatedCount > 0) {
      logger.info('订单状态更新成功', { orderNumber, status });
      return true;
    } else {
      logger.warn('订单不存在', { orderNumber });
      return false;
    }
  } catch (error) {
    logger.error('更新订单状态失败', {
      orderNumber,
      status,
      error: error.message,
    });
    throw error;
  }
}

/**
 * 获取待爬取的订单列表
 * @param {number} limit - 限制数量
 * @returns {Promise<Array>} 订单列表
 */
async function getPendingOrders(limit = 10) {
  try {
    const orders = await Order.findAll({
      where: {
        status: 'pending',
        lastCrawledAt: null,
      },
      limit,
      order: [['createdAt', 'ASC']],
    });

    return orders;
  } catch (error) {
    logger.error('获取待爬取订单失败', { error: error.message });
    throw error;
  }
}

module.exports = {
  saveOrderFromEmail,
  getOrderByNumber,
  updateOrderStatus,
  getPendingOrders,
};
