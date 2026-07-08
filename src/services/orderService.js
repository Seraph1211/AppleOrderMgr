/**
 * 订单服务
 * @description 处理订单相关的数据库操作，包括创建订单、更新订单、关联 Apple ID 和收件人
 * @author Seraph
 * @date 2026-07-07
 */

const { sequelize, AppleId, Recipient, Order, EmailLog } = require('../models');
const logger = require('../utils/logger');
const { isValidOrderNumber, isValidEmail } = require('../utils/helpers');

/**
 * 从邮件数据保存订单
 * @param {Object} emailData - 解析后的邮件数据
 * @param {string} emailUid - 邮件唯一标识符
 * @returns {Promise<Object>} 创建的订单对象
 */
async function saveOrderFromEmail(emailData, emailUid) {
  const transaction = await sequelize.transaction();

  try {
    logger.info('开始保存订单', {
      emailUid,
      orderNumber: emailData.orderNumber,
      appleId: emailData.appleId
    });

    // 1. 验证订单号格式
    if (!isValidOrderNumber(emailData.orderNumber)) {
      throw new Error(`订单号格式无效: ${emailData.orderNumber}`);
    }

    // 2. 验证 Apple ID 格式
    if (!isValidEmail(emailData.appleId)) {
      throw new Error(`Apple ID 格式无效: ${emailData.appleId}`);
    }

    // 3. 检查订单是否已存在
    const existingOrder = await Order.findOne({
      where: { orderNumber: emailData.orderNumber },
      transaction
    });

    if (existingOrder) {
      logger.warn('订单已存在，跳过创建', {
        orderNumber: emailData.orderNumber,
        existingOrderId: existingOrder.id
      });

      // 更新邮件日志
      await createEmailLog(emailUid, emailData, true, existingOrder.id, transaction);

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
      recipientAddress: null
    };

    if (emailData.recipient?.name && emailData.recipient?.idLast4) {
      const recipient = await Recipient.findOne({
        where: {
          // 姓名匹配：拆分姓和名
          lastName: emailData.recipient.name.substring(0, 1),
          firstName: emailData.recipient.name.substring(1),
          idCardLast4: emailData.recipient.idLast4
        },
        transaction
      });

      if (recipient) {
        recipientData.recipientRef = recipient.id;
        recipientData.recipientIdCard = recipient.idCardNumber;
        recipientData.recipientEmail = recipient.email;
        recipientData.recipientPhone = recipient.phone;
        recipientData.recipientAddress = `${recipient.province || ''}${recipient.city || ''}${recipient.district || ''}${recipient.streetAddress || ''}`;

        logger.info('收件人信息自动匹配成功', {
          recipientId: recipient.id,
          name: emailData.recipient.name,
          idLast4: emailData.recipient.idLast4
        });
      } else {
        logger.warn('未找到匹配的收件人', {
          name: emailData.recipient.name,
          idLast4: emailData.recipient.idLast4
        });
      }
    }

    // 5. 自动匹配 apple_ids 表
    let appleData = {
      appleIdRef: null,
      appleId: emailData.appleId,
      applePassword: null
    };

    const appleAccount = await AppleId.findOne({
      where: { appleId: emailData.appleId },
      transaction
    });

    if (appleAccount) {
      appleData.appleIdRef = appleAccount.id;
      appleData.applePassword = appleAccount.password;

      logger.info('Apple ID 自动匹配成功', {
        appleId: emailData.appleId,
        appleIdId: appleAccount.id
      });
    } else {
      logger.warn('未找到匹配的 Apple ID', {
        appleId: emailData.appleId
      });
    }

    // 6. 直接创建订单，保存快照数据
    // 调试日志：记录即将保存的数据
    logger.info('准备创建订单，数据如下：', {
      orderNumber: emailData.orderNumber,
      ...appleData,
      ...recipientData,
      tag: emailData.recipient?.tag,
      tagLength: emailData.recipient?.tag?.length
    });

    const order = await Order.create({
      orderNumber: emailData.orderNumber,
      // Apple ID 信息
      ...appleData,
      // 收件人信息（快照）
      ...recipientData,
      // 订单信息
      products: emailData.products, // JSONB 数组
      status: 'pending', // 初始状态为待处理
      orderUrl: emailData.orderUrl,
      paymentMethod: emailData.paymentMethod || null,
      orderDate: emailData.orderDate,
      tag: emailData.recipient?.tag || null
    }, { transaction });

    logger.info('订单创建成功', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      productCount: order.products.length
    });

    // 7. 创建邮件日志
    await createEmailLog(emailUid, emailData, true, order.id, transaction);

    // 8. 提交事务
    await transaction.commit();

    logger.info('✅ 订单保存完成', {
      emailUid,
      orderId: order.id,
      orderNumber: order.orderNumber,
      appleId: emailData.appleId
    });

    return order;
  } catch (error) {
    // 回滚事务
    await transaction.rollback();

    logger.error('订单保存失败', {
      emailUid,
      orderNumber: emailData.orderNumber,
      error: error.message,
      stack: error.stack
    });

    // 记录失败的邮件日志
    try {
      await createEmailLog(emailUid, emailData, false, null, null, error.message);
    } catch (logError) {
      logger.error('记录邮件日志失败', { logError: logError.message });
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
async function createEmailLog(emailUid, emailData, success, _orderId = null, transaction = null, errorMessage = null) {
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
    parsedData: success ? {
      appleId: emailData.appleId,
      orderNumber: emailData.orderNumber,
      products: emailData.products,
      recipient: emailData.recipient,
      paymentMethod: emailData.paymentMethod
    } : null,
    orderNumber: emailData.orderNumber || null,
    retryCount: 0
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
        { model: Recipient, as: 'recipient' }
      ]
    });

    return order;
  } catch (error) {
    logger.error('查询订单失败', {
      orderNumber,
      error: error.message
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
    const [updatedCount] = await Order.update(
      { status },
      { where: { orderNumber } }
    );

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
      error: error.message
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
        lastCrawledAt: null
      },
      limit,
      order: [['createdAt', 'ASC']]
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
  getPendingOrders
};
