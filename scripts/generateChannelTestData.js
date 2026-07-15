/**
 * 渠道管理测试数据生成脚本
 * @description 为渠道管理功能生成模拟数据
 */

const { sequelize, Order, Recipient, AppleId } = require('../src/models');
const logger = require('../src/utils/logger');

// 渠道列表
const CHANNELS = [
  '水果惠',
  '刘天佟 微信',
  '群华华 微信',
  '张三代购',
  '李四团购',
  '王五渠道',
];

// 订单状态
const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'ready_for_pickup', 'completed', 'cancelled'];

// 付款方式
const PAYMENT_METHODS = ['支付宝', '微信支付', '银行卡', '花呗'];

// 取货门店
const PICKUP_STORES = [
  'Apple 重庆万象城',
  'Apple 上海南京东路',
  'Apple 北京三里屯',
  'Apple 广州天环广场',
  'Apple 深圳益田假日广场',
  'Apple 成都万象城',
];

// 商品列表
const PRODUCTS = [
  { modelId: 'MG714CH/A', name: 'iPhone 17 鼠尾草绿色 256G' },
  { modelId: 'MG715CH/A', name: 'iPhone 17 Pro 钛金色 512G' },
  { modelId: 'MG716CH/A', name: 'iPhone 17 Pro Max 深空黑色 1TB' },
  { modelId: 'MG717CH/A', name: 'iPad Pro 13 英寸 256G' },
  { modelId: 'HNPW2ZM/A', name: 'Belkin Secure Holder 挂绳' },
  { modelId: 'MW223CH/A', name: 'AirPods Pro (第 3 代)' },
  { modelId: 'MK2E3CH/A', name: 'Apple Watch Ultra 2' },
];

// 姓名列表
const LAST_NAMES = ['张', '李', '王', '刘', '陈', '杨', '赵', '黄', '周', '吴'];
const FIRST_NAMES = ['伟', '芳', '娜', '秀英', '敏', '静', '丽', '强', '磊', '军', '洋', '勇', '艳', '杰', '涛'];

/**
 * 生成随机姓名
 */
function generateName() {
  const lastName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  const firstName = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)] +
    (Math.random() > 0.5 ? FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)] : '');
  return { lastName, firstName };
}

/**
 * 生成随机身份证号
 */
function generateIdCard() {
  const area = ['110101', '310101', '440101', '500101', '510101', '320101'];
  const areaCode = area[Math.floor(Math.random() * area.length)];
  const year = 1980 + Math.floor(Math.random() * 30);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  const seq = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const checkCode = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'X'][Math.floor(Math.random() * 11)];
  return `${areaCode}${year}${month}${day}${seq}${checkCode}`;
}

/**
 * 生成随机手机号
 */
function generatePhone() {
  const prefix = ['130', '131', '132', '133', '135', '136', '137', '138', '139', '150', '151', '152', '153', '155', '156', '157', '158', '159', '180', '181', '182', '183', '185', '186', '187', '188', '189'];
  return prefix[Math.floor(Math.random() * prefix.length)] + String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
}

/**
 * 生成随机日期
 */
function generateDate(daysAgo = 30) {
  const date = new Date();
  date.setDate(date.getDate() - Math.floor(Math.random() * daysAgo));
  return date;
}

/**
 * 生成订单号
 */
function generateOrderNumber() {
  return `W${String(Math.floor(Math.random() * 10000000000)).padStart(10, '0')}`;
}

/**
 * 随机选择
 */
function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

/**
 * 生成测试数据
 */
async function generateTestData() {
  const transaction = await sequelize.transaction();

  try {
    logger.info('开始生成渠道管理测试数据');

    // 1. 创建 Apple ID（如果不存在）
    const appleIds = [];
    for (let i = 0; i < 5; i += 1) {
      const [appleId] = await AppleId.findOrCreate({
        where: { appleId: `test${i + 1}@example.com` },
        defaults: {
          appleId: `test${i + 1}@example.com`,
          password: `Password${i + 1}23`,
          nickname: `测试账号${i + 1}`,
          country: randomChoice(['美国', '中国', '日本']),
          status: '使用中',
        },
        transaction,
      });
      appleIds.push(appleId);
    }

    logger.info('Apple ID 创建完成', { count: appleIds.length });

    // 2. 创建取机人
    const recipients = [];
    for (let i = 0; i < 30; i += 1) {
      const { lastName, firstName } = generateName();
      const tag = randomChoice(CHANNELS);
      const idCard = generateIdCard();

      const [recipient] = await Recipient.findOrCreate({
        where: { idCardNumber: idCard },
        defaults: {
          lastName,
          firstName,
          idCardNumber: idCard,
          phone: generatePhone(),
          email: `${firstName}${lastName}@example.com`,
          province: randomChoice(['重庆', '上海', '北京', '广东', '四川']),
          city: randomChoice(['重庆', '上海', '北京', '广州', '深圳', '成都']),
          district: randomChoice(['江北区', '黄浦区', '朝阳区', '天河区', '南山区', '锦江区']),
          streetAddress: `测试街道${i + 1}号`,
          tag,
          status: '使用中',
        },
        transaction,
      });
      recipients.push(recipient);
    }

    logger.info('取机人创建完成', { count: recipients.length });

    // 3. 创建订单
    const orders = [];
    const ORDERS_COUNT = 100; // 每个渠道平均15-20个订单

    for (let i = 0; i < ORDERS_COUNT; i += 1) {
      const tag = randomChoice(CHANNELS);
      const recipient = randomChoice(recipients.filter((r) => r.tag === tag)) || randomChoice(recipients);
      const appleId = randomChoice(appleIds);
      const status = randomChoice(ORDER_STATUSES);
      const productCount = 1 + Math.floor(Math.random() * 3); // 1-3个商品

      const products = [];
      for (let j = 0; j < productCount; j += 1) {
        const product = randomChoice(PRODUCTS);
        products.push({
          model: product.modelId,
          name: product.name,
          quantity: 1 + Math.floor(Math.random() * 2), // 1-2个
          status: status === 'completed' ? 'DELIVERED' : 'READY_FOR_PICKUP',
          imageUrl: 'https://store.storeimages.cdn-apple.com/placeholder.jpg',
        });
      }

      const orderNumber = generateOrderNumber();
      const orderDate = generateDate(30);

      const order = await Order.create({
        orderNumber,
        appleIdRef: appleId.id,
        appleId: appleId.appleId,
        applePassword: appleId.password,
        recipientRef: recipient.id,
        recipientName: `${recipient.lastName}${recipient.firstName}`,
        recipientIdCard: recipient.idCardNumber,
        recipientPhone: recipient.phone,
        recipientEmail: recipient.email,
        recipientAddress: `${recipient.province}${recipient.city}${recipient.district}${recipient.streetAddress}`,
        products,
        status,
        orderUrl: `https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/${appleId.appleId}`,
        orderDate,
        pickupStore: randomChoice(PICKUP_STORES),
        pickupStoreCode: `R${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`,
        pickupTimeSlot: `${String(10 + Math.floor(Math.random() * 10))}:${randomChoice(['00', '30'])}-${String(10 + Math.floor(Math.random() * 10))}:${randomChoice(['00', '30'])}`,
        paymentMethod: randomChoice(PAYMENT_METHODS),
        tag,
        lastCrawledAt: new Date(),
        crawlFailCount: 0,
      }, { transaction });

      orders.push(order);
    }

    logger.info('订单创建完成', { count: orders.length });

    await transaction.commit();

    // 4. 统计渠道数据
    logger.info('测试数据生成完成！');
    logger.info('================== 渠道统计 ==================');

    for (const channel of CHANNELS) {
      const orderCount = orders.filter((o) => o.tag === channel).length;
      const completedCount = orders.filter((o) => o.tag === channel && o.status === 'completed').length;
      const recipientCount = recipients.filter((r) => r.tag === channel).length;

      logger.info(`渠道: ${channel}`, {
        订单数: orderCount,
        已完成: completedCount,
        取机人数: recipientCount,
      });
    }

    logger.info('=============================================');
    logger.info('请访问 http://localhost:3001/channels 查看渠道管理页面');

    process.exit(0);
  } catch (error) {
    await transaction.rollback();
    logger.error('生成测试数据失败', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// 运行脚本
generateTestData();
