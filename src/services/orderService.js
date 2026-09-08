/**
 * 订单服务
 * @description 处理订单相关的数据库操作，包括创建订单、更新订单、关联 Apple ID 和收件人
 * @author Seraph
 * @date 2026-07-07
 */

const {
  sequelize,
  Sequelize,
  AppleId,
  Recipient,
  Order,
  EmailLog,
  OrderRefreshSchedule,
  OrderRefreshJob,
} = require('../models');
const logger = require('../utils/logger');
const { isValidOrderNumber, isValidEmail } = require('../utils/helpers');
const { EMAIL_ERROR_CODES, EmailProcessingError } = require('./emailErrors');
const paymentDispatchService = require('./paymentDispatchService');

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
        await createEmailLog(emailUid, emailData, true, existingOrder.id, transaction);
      }

      await transaction.commit();
      return existingOrder;
    }

    // 4. 自动匹配 recipients 表（根据姓名 + 身份证后4位）
    let recipientData = {
      recipientRef: null,
      recipientName: emailData.recipient?.name || null,
      recipientIdCard: null,
      recipientEmail: null,
      recipientPhone: null,
      recipientAddress: null,
    };

    if (emailData.recipient?.name && emailData.recipient?.idLast4) {
      const recipient = await Recipient.findOne({
        where: {
          // 姓名匹配：拆分姓和名
          lastName: emailData.recipient.name.substring(0, 1),
          firstName: emailData.recipient.name.substring(1),
          idCardLast4: emailData.recipient.idLast4,
        },
        transaction,
      });

      if (recipient) {
        recipientData.recipientRef = recipient.id;
        recipientData.recipientIdCard = recipient.idCardNumber;
        recipientData.recipientEmail = recipient.email;
        recipientData.recipientPhone = recipient.phone;
        recipientData.recipientAddress = [
          recipient.province,
          recipient.city,
          recipient.district,
          recipient.streetAddress,
        ]
          .filter(Boolean)
          .join('');

        logger.info('取机人信息自动匹配成功', {
          emailRecordId: options.emailLogId || null,
          recipientId: recipient.id,
        });
      } else {
        logger.warn('未找到匹配的取机人', { emailRecordId: options.emailLogId || null });
      }
    }

    recipientData = {
      ...recipientData,
      recipientIdCard: emailData.recipient?.idCard || recipientData.recipientIdCard,
      recipientEmail: emailData.recipient?.email || recipientData.recipientEmail,
      recipientPhone: emailData.recipient?.phone || recipientData.recipientPhone,
      recipientAddress: emailData.recipient?.address || recipientData.recipientAddress,
    };

    // 5. 自动匹配 apple_ids 表
    let appleData = {
      appleIdRef: null,
      appleId: emailData.appleId,
      applePassword: emailData.applePassword || null,
    };

    const appleAccount = await AppleId.findOne({
      where: { appleId: emailData.appleId },
      transaction,
    });

    if (appleAccount) {
      appleData.appleIdRef = appleAccount.id;
      appleData.applePassword = emailData.applePassword || appleAccount.password;

      logger.info('Apple ID 自动匹配成功', {
        appleIdId: appleAccount.id,
      });
    } else {
      logger.warn('未找到匹配的 Apple ID', { emailRecordId: options.emailLogId || null });
    }

    // 6. 直接创建订单，保存快照数据
    logger.info('准备创建订单', {
      emailRecordId: options.emailLogId || null,
      appleIdRef: appleData.appleIdRef,
      recipientRef: recipientData.recipientRef,
      productCount: emailData.products.length,
      hasTag: Boolean(emailData.recipient?.tag),
    });

    const order = await Order.create(
      {
        orderNumber: emailData.orderNumber,
        // Apple ID 信息
        ...appleData,
        // 收件人信息（快照）
        ...recipientData,
        // 订单信息
        products: emailData.products, // JSONB 数组
        status: emailData.orderStatus || 'pending',
        orderUrl: emailData.orderUrl,
        paymentMethod: emailData.paymentMethod || null,
        orderDate: emailData.orderDate,
        tag: emailData.recipient?.tag || null,
      },
      { transaction }
    );

    logger.info('订单创建成功', {
      emailRecordId: options.emailLogId || null,
      orderId: order.id,
      productCount: order.products.length,
    });

    // 与订单创建同一事务写入首次刷新任务，避免提交后进程退出导致任务丢失。
    const refreshScheduledAt = new Date();
    await OrderRefreshSchedule.create(
      {
        orderId: order.id,
        nextAutoRefreshAt: order.orderUrl ? refreshScheduledAt : null,
        freshnessStatus: 'stale',
      },
      { transaction }
    );
    if (order.orderUrl) {
      await OrderRefreshJob.create(
        {
          orderId: order.id,
          trigger: 'auto',
          status: 'pending',
          priority: 250,
          scheduledAt: refreshScheduledAt,
        },
        { transaction }
      );
    }
    await paymentDispatchService.enrollOrderInTransaction(order, transaction);

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
      await createEmailLog(emailUid, emailData, true, order.id, transaction);
    }

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
    if (!options.emailLogId) {
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
