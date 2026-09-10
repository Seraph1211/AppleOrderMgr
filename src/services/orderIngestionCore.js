/** 公共订单创建：调用方持有来源锁及订单号锁，所有后续任务在同一事务登记。 */
const { AppleId, Recipient, Order, OrderRefreshSchedule, OrderRefreshJob } = require('../models');
const logger = require('../utils/logger');
const paymentDispatchService = require('./paymentDispatchService');

/** 创建订单与首次任务。 @param {Object} emailData 标准化来源资料 @param {Object} transaction 事务 @param {Object} options 来源选项 @returns {Promise<Object>} 订单 */
async function createOrderInTransaction(emailData, transaction, options = {}) {
  try {
    // 4. 自动匹配 recipients 表（根据姓名 + 身份证后4位）
    let recipientData = {
      recipientRef: null,
      recipientName: emailData.recipient?.name || null,
      recipientIdCard: null,
      recipientEmail: null,
      recipientPhone: null,
      recipientAddress: null,
    };

    if (options.source === 'aos') {
      const recipientWhere = {
        lastName: emailData.sourceLastName,
        firstName: emailData.sourceFirstName,
        phone: emailData.recipient.phone,
      };
      if (emailData.recipient.idLast4) {
        recipientWhere.idCardLast4 = emailData.recipient.idLast4;
      }
      const candidates = await Recipient.findAll({
        where: recipientWhere,
        limit: 2,
        transaction,
      });
      const matched = candidates.length === 1 ? candidates[0] : null;
      if (
        matched &&
        (!matched.email || matched.email.toLowerCase() === emailData.recipient.email.toLowerCase())
      ) {
        recipientData.recipientRef = matched.id;
        recipientData.recipientIdCard = matched.idCardNumber;
      }
    } else if (emailData.recipient?.name && emailData.recipient?.idLast4) {
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
        ingestionSource: options.source || 'email',
        ...(options.source === 'aos'
          ? {
            sourceRecipientTag: emailData.recipient?.tag || null,
            sourceContactEmail: emailData.recipient?.email,
            sourceLastName: emailData.sourceLastName,
            sourceFirstName: emailData.sourceFirstName,
            pickupStoreCode: emailData.pickupStoreCode,
            pickupStore: emailData.pickupStore || null,
          }
          : {}),
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

    return order;
  } catch (error) {
    logger.warn('公共订单创建已回滚', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}
module.exports = { createOrderInTransaction };
