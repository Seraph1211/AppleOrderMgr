/** 公共订单创建：调用方持有来源锁及订单号锁，所有后续任务在同一事务登记。 */
const { sequelize, AppleId, Order, OrderRefreshSchedule, OrderRefreshJob } = require('../models');
const logger = require('../utils/logger');
const paymentDispatchService = require('./paymentDispatchService');
const { findRecipientForOrder } = require('./profileOrderMatching');

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

    const matchedRecipient = await findRecipientForOrder(
      {
        recipientName: emailData.recipient?.name,
        recipientIdCard: emailData.recipient?.idCard,
        recipientIdLast4: emailData.recipient?.idLast4,
        recipientPhone: emailData.recipient?.phone,
        recipientEmail: emailData.recipient?.email,
        ingestionSource: options.source || 'email',
      },
      transaction
    );
    if (matchedRecipient) {
      recipientData = {
        recipientRef: matchedRecipient.id,
        recipientName: emailData.recipient?.name,
        recipientIdCard: matchedRecipient.idCardNumber,
        recipientEmail: matchedRecipient.email,
        recipientPhone: matchedRecipient.phone,
        recipientAddress: [
          matchedRecipient.province,
          matchedRecipient.city,
          matchedRecipient.district,
          matchedRecipient.streetAddress,
        ]
          .filter(Boolean)
          .join(''),
      };
    }

    recipientData = {
      ...recipientData,
      recipientIdLast4: emailData.recipient?.idLast4?.toUpperCase() || null,
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
      where: sequelize.where(
        sequelize.fn('lower', sequelize.fn('trim', sequelize.col('apple_id'))),
        (emailData.appleId || '').trim().toLowerCase()
      ),
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

    const sourceFields = {};
    if (options.source === 'aos') {
      Object.assign(sourceFields, {
        sourceRecipientTag: emailData.recipient?.tag || null,
        sourceContactEmail: emailData.recipient?.email,
        sourceLastName: emailData.sourceLastName,
        sourceFirstName: emailData.sourceFirstName,
        pickupStoreCode: emailData.pickupStoreCode,
        pickupStore: emailData.pickupStore || null,
      });
    }
    const order = await Order.create(
      {
        orderNumber: emailData.orderNumber,
        ingestionSource: options.source || 'email',
        ...sourceFields,
        // Apple ID 信息
        ...appleData,
        // 收件人信息（快照）
        ...recipientData,
        // 订单信息
        products: emailData.products, // JSONB 数组
        // 来源状态不代表已确认的官网观测；首次异步抓取后再更新。
        status: 'pending',
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
        nextAutoRefreshAt: null,
        freshnessStatus: 'stale',
      },
      { transaction }
    );
    if (order.orderUrl) {
      await OrderRefreshJob.create(
        {
          orderId: order.id,
          trigger: 'initial',
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
