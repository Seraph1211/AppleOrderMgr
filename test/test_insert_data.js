/**
 * 插入测试数据
 * 模拟前端页面手动导入 Apple ID 和收件人数据
 */

const { AppleId, Recipient } = require('./src/models');
const logger = require('./src/utils/logger');

async function insertTestData() {
  try {
    logger.info('开始插入测试数据...');

    // 1. 插入测试 Apple ID
    const [appleId, appleIdCreated] = await AppleId.findOrCreate({
      where: { appleId: 'test@example.com' },
      defaults: {
        appleId: 'test@example.com',
        password: 'test_password_123',
        nickname: '测试账号',
        status: 'active'
      }
    });

    if (appleIdCreated) {
      logger.info('✅ Apple ID 创建成功', {
        id: appleId.id,
        appleId: appleId.appleId
      });
    } else {
      logger.info('Apple ID 已存在', {
        id: appleId.id,
        appleId: appleId.appleId
      });
    }

    // 2. 插入测试收件人
    const [recipient, recipientCreated] = await Recipient.findOrCreate({
      where: { idCardLast4: '1234' },
      defaults: {
        lastName: '张',
        firstName: '三',
        idCardNumber: '110101199001011234', // 完整的18位身份证号
        idCardLast4: '1234',
        phone: '13800138000',
        appleIdRef: appleId.id,
        status: 'active'
      }
    });

    if (recipientCreated) {
      logger.info('✅ 收件人创建成功', {
        id: recipient.id,
        name: `${recipient.lastName}${recipient.firstName}`,
        idCardLast4: recipient.idCardLast4
      });
    } else {
      logger.info('收件人已存在', {
        id: recipient.id,
        name: `${recipient.lastName}${recipient.firstName}`,
        idCardLast4: recipient.idCardLast4
      });
    }

    logger.info('✅ 测试数据准备完成');
    process.exit(0);

  } catch (error) {
    logger.error('插入测试数据失败', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

insertTestData();
