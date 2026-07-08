/**
 * 数据库连接和模型操作测试脚本
 * @description 验证数据库连接、模型定义和基本 CRUD 操作
 */

const { sequelize, AppleId, Recipient, Order, EmailLog, CrawlLog } = require('./src/models');
const logger = require('./src/utils/logger');

/**
 * 测试数据库连接
 */
async function testConnection() {
  try {
    await sequelize.authenticate();
    logger.info('✅ 数据库连接成功');
    return true;
  } catch (error) {
    logger.error('❌ 数据库连接失败', { error: error.message });
    return false;
  }
}

/**
 * 测试模型基本操作
 */
async function testModels() {
  const transaction = await sequelize.transaction();

  try {
    logger.info('开始测试模型操作...');

    // 1. 创建 Apple ID
    const appleId = await AppleId.create({
      appleId: 'test@example.com',
      password: 'test_password_123',
      nickname: '测试账号',
      country: '中国',
      securityQa: {
        questions: [
          { question: '你的出生地是？', answer: '北京' },
          { question: '你的宠物名字是？', answer: '小白' }
        ]
      },
      status: 'active'
    }, { transaction });

    logger.info('✅ AppleId 创建成功', { id: appleId.id, appleId: appleId.appleId });

    // 2. 创建收件人
    const recipient = await Recipient.create({
      lastName: '张',
      firstName: '三',
      idCardNumber: '110101199001011234',
      phone: '13800138000',
      email: 'zhangsan@example.com',
      province: '北京市',
      city: '北京市',
      district: '朝阳区',
      streetAddress: '建国路1号',
      appleIdRef: appleId.id,
      tag: '测试批次',
      status: 'active'
    }, { transaction });

    logger.info('✅ Recipient 创建成功', {
      id: recipient.id,
      name: `${recipient.lastName}${recipient.firstName}`,
      idCardLast4: recipient.idCardLast4
    });

    // 3. 创建订单
    const order = await Order.create({
      orderNumber: 'W123456789',
      appleIdRef: appleId.id,
      recipientRef: recipient.id,
      products: [
        {
          model: 'MG714CH/A',
          name: 'iPhone 17 鼠尾草绿色 256G',
          quantity: 2,
          image: null
        },
        {
          model: 'HNPW2ZM/A',
          name: 'Belkin挂绳',
          quantity: 1,
          image: null
        }
      ],
      status: 'pending',
      paymentMethod: '支付宝',
      tag: '水果惠',
      orderDate: new Date()
    }, { transaction });

    logger.info('✅ Order 创建成功', {
      id: order.id,
      orderNumber: order.orderNumber,
      productCount: order.products.length
    });

    // 4. 创建邮件日志
    const emailLog = await EmailLog.create({
      emailUid: 'test-email-uid-001',
      emailSubject: '【NULL AOS Helper】订单通知',
      emailFrom: 'noreply@example.com',
      emailDate: new Date(),
      source: 'imap',
      processed: true,
      success: true,
      orderNumber: order.orderNumber,
      parsedData: {
        orderNumber: 'W123456789',
        appleId: 'test@example.com',
        products: order.products
      }
    }, { transaction });

    logger.info('✅ EmailLog 创建成功', { id: emailLog.id, emailUid: emailLog.emailUid });

    // 5. 创建爬虫日志
    const crawlLog = await CrawlLog.create({
      orderId: order.id,
      source: 'auto',
      proxyIp: '192.168.1.100',
      success: true,
      responseTime: 1500,
      httpStatus: 200,
      crawledData: {
        status: '处理中',
        pickupStore: 'Apple Store 北京三里屯'
      }
    }, { transaction });

    logger.info('✅ CrawlLog 创建成功', { id: crawlLog.id, orderId: crawlLog.orderId });

    // 6. 测试关联查询
    const orderWithRelations = await Order.findOne({
      where: { orderNumber: 'W123456789' },
      include: [
        { model: AppleId, as: 'appleAccount' },
        { model: Recipient, as: 'recipient' }
      ],
      transaction
    });

    logger.info('✅ 关联查询成功', {
      orderNumber: orderWithRelations.orderNumber,
      appleId: orderWithRelations.appleAccount?.appleId,
      recipientName: `${orderWithRelations.recipient?.lastName}${orderWithRelations.recipient?.firstName}`
    });

    // 提交事务
    await transaction.commit();
    logger.info('✅ 事务提交成功');

    // 7. 清理测试数据
    await Order.destroy({ where: { orderNumber: 'W123456789' } });
    await EmailLog.destroy({ where: { emailUid: 'test-email-uid-001' } });
    await Recipient.destroy({ where: { idCardNumber: '110101199001011234' } });
    await AppleId.destroy({ where: { appleId: 'test@example.com' } });

    logger.info('✅ 测试数据清理完成');

    return true;
  } catch (error) {
    await transaction.rollback();
    logger.error('❌ 模型操作测试失败', {
      error: error.message,
      stack: error.stack
    });
    return false;
  }
}

/**
 * 主测试函数
 */
async function runTests() {
  console.log('\n========================================');
  console.log('数据库连接和模型操作测试');
  console.log('========================================\n');

  try {
    // 测试连接
    const connectionOk = await testConnection();
    if (!connectionOk) {
      console.log('\n❌ 数据库连接失败，测试终止\n');
      process.exit(1);
    }

    // 测试模型操作
    const modelsOk = await testModels();
    if (!modelsOk) {
      console.log('\n❌ 模型操作测试失败\n');
      process.exit(1);
    }

    console.log('\n========================================');
    console.log('✅ 所有测试通过');
    console.log('========================================\n');
    process.exit(0);
  } catch (error) {
    logger.error('❌ 测试执行失败', { error: error.message });
    console.log('\n❌ 测试执行失败\n');
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

// 执行测试
runTests();
