/**
 * 爬虫服务测试脚本
 * 功能：测试订单爬取功能，包括 HTML 解析、数据提取、数据库更新
 * 作者：Seraph
 * 更新：2026-07-07
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const crawlerService = require('./src/services/crawlerService');
const logger = require('./src/utils/logger');
const proxyManager = require('./src/utils/proxyManager');
const { Order, AppleId, Recipient, sequelize } = require('./src/models');

/**
 * 测试 1: 提取和解析订单 JSON
 */
function testExtractAndParse() {
  console.log('\n=== 测试 1: 提取和解析订单 JSON ===\n');

  try {
    // 检查是否有测试 HTML 文件
    const testHtmlPath = path.join(__dirname, 'test', 'fixtures', 'order_page.html');

    if (!fs.existsSync(testHtmlPath)) {
      console.log('⚠️  未找到测试 HTML 文件，跳过此测试');
      console.log(`   请将订单页面 HTML 保存到: ${testHtmlPath}`);
      return;
    }

    const html = fs.readFileSync(testHtmlPath, 'utf-8');

    console.log('📄 读取测试 HTML 文件成功');

    // 提取 JSON
    const orderJson = crawlerService.extractOrderJson(html);

    if (!orderJson) {
      console.log('❌ 未能提取订单 JSON');
      return;
    }

    console.log('✅ 成功提取订单 JSON');

    // 解析数据
    const orderData = crawlerService.parseOrderData(orderJson, html);

    console.log('\n📦 解析结果:');
    console.log(`   订单号: ${orderData.orderNumber}`);
    console.log(`   下单日期: ${orderData.orderDate}`);
    console.log(`   订单状态: ${orderData.orderStatus}`);
    console.log(`   取机门店: ${orderData.pickupStore}`);
    console.log(`   商品数量: ${orderData.products.length}`);

    orderData.products.forEach((product, index) => {
      console.log(`\n   商品 ${index + 1}:`);
      console.log(`     - 名称: ${product.name}`);
      console.log(`     - 型号: ${product.model}`);
      console.log(`     - 数量: ${product.quantity}`);
      console.log(`     - 状态: ${product.status}`);
      console.log(`     - 图片: ${product.imageUrl ? '有' : '无'}`);
    });

    console.log('\n✅ 测试 1 通过\n');
  } catch (error) {
    console.error('❌ 测试 1 失败:', error.message);
    logger.error('测试 1 失败', { error: error.message, stack: error.stack });
  }
}

/**
 * 测试 2: 真实订单爬取（需要有效的订单 URL）
 */
async function testRealCrawl() {
  console.log('\n=== 测试 2: 真实订单爬取 ===\n');

  try {
    // 配置测试订单 URL（需要替换为真实订单）
    const testOrderNumber = process.env.TEST_ORDER_NUMBER || 'W1234567890';
    const testAppleId = process.env.TEST_APPLE_ID || 'test@example.com';
    const orderUrl = `https://www.apple.com.cn/xc/cn/vieworder/${testOrderNumber}/${testAppleId}`;

    console.log('🌐 测试订单 URL:', orderUrl);
    console.log('⚠️  注意: 需要在 .env 中配置真实的 TEST_ORDER_NUMBER 和 TEST_APPLE_ID');

    if (testOrderNumber === 'W1234567890' || testAppleId === 'test@example.com') {
      console.log('⏭️  跳过真实爬取测试（请配置真实订单信息）');
      return;
    }

    // 初始化代理池（如果启用）
    if (process.env.PROXY_ENABLED === 'true') {
      console.log('🔄 初始化代理池...');
      await proxyManager.initialize();
      console.log('✅ 代理池初始化成功');
    }

    // 执行爬取
    console.log('🕷️  开始爬取订单...');
    const result = await crawlerService.fetchWithRetry(orderUrl);

    console.log('\n✅ 爬取成功!');
    console.log('\n📦 爬取结果:');
    console.log(JSON.stringify(result.data, null, 2));

    console.log('\n✅ 测试 2 通过\n');
  } catch (error) {
    console.error('❌ 测试 2 失败:', error.message);
    logger.error('测试 2 失败', { error: error.message, stack: error.stack });
  }
}

/**
 * 测试 3: 订单数据库更新
 */
async function testDatabaseUpdate() {
  console.log('\n=== 测试 3: 订单数据库更新 ===\n');

  const transaction = await sequelize.transaction();

  try {
    // 1. 创建测试数据
    console.log('📝 创建测试订单数据...');

    const appleId = await AppleId.create(
      {
        appleId: 'test_crawler@example.com',
        password: '',
        status: 'active',
      },
      { transaction }
    );

    const recipient = await Recipient.create(
      {
        lastName: '测试',
        firstName: '用户',
        idCardNumber: '110101199001011234',
        idCardLast4: '1234',
      },
      { transaction }
    );

    const order = await Order.create(
      {
        orderNumber: 'W999999999',
        appleIdId: appleId.id,
        recipientId: recipient.id,
        products: [
          {
            model: 'TEST-MODEL',
            name: '测试产品',
            quantity: 1,
          },
        ],
        paymentMethod: 'test',
        status: 'pending',
        source: 'test',
      },
      { transaction }
    );

    console.log(`✅ 测试订单创建成功 (ID: ${order.id})`);

    // 2. 模拟爬取结果并更新
    console.log('🔄 模拟更新订单数据...');

    const mockCrawledData = {
      orderNumber: 'W999999999',
      orderDate: '2026-07-07',
      orderStatus: 'processing',
      products: [
        {
          model: 'TEST-MODEL',
          name: '测试产品',
          quantity: 1,
          status: 'processing',
          imageUrl: 'https://example.com/image.jpg',
          deliveryType: 'RETAIL_STORE',
        },
      ],
      pickupStore: 'Apple 测试门店',
      storeDirectionsUrl: null,
      rawJson: { test: 'data' },
    };

    await order.update(
      {
        status: mockCrawledData.orderStatus,
        crawledData: mockCrawledData.rawJson,
        pickupStore: mockCrawledData.pickupStore,
        orderDate: mockCrawledData.orderDate,
        lastCrawledAt: new Date(),
        products: mockCrawledData.products,
      },
      { transaction }
    );

    console.log('✅ 订单数据更新成功');

    // 3. 验证更新结果
    const updatedOrder = await Order.findByPk(order.id, {
      include: ['appleAccount', 'recipient'],
      transaction,
    });

    console.log('\n📦 更新后的订单数据:');
    console.log(`   订单号: ${updatedOrder.orderNumber}`);
    console.log(`   状态: ${updatedOrder.status}`);
    console.log(`   取机门店: ${updatedOrder.pickupStore}`);
    console.log(`   下单日期: ${updatedOrder.orderDate}`);
    console.log(`   最后爬取时间: ${updatedOrder.lastCrawledAt}`);
    console.log(`   商品数量: ${updatedOrder.products.length}`);

    // 4. 清理测试数据
    await transaction.rollback();
    console.log('🧹 测试数据已回滚');

    console.log('\n✅ 测试 3 通过\n');
  } catch (error) {
    await transaction.rollback();
    console.error('❌ 测试 3 失败:', error.message);
    logger.error('测试 3 失败', { error: error.message, stack: error.stack });
  }
}

/**
 * 测试 4: 完整的爬取更新流程（需要真实订单）
 */
async function testFullCrawlAndUpdate() {
  console.log('\n=== 测试 4: 完整的爬取更新流程 ===\n');

  const transaction = await sequelize.transaction();

  try {
    // 配置测试订单
    const testOrderNumber = process.env.TEST_ORDER_NUMBER;
    const testAppleId = process.env.TEST_APPLE_ID;

    if (!testOrderNumber || !testAppleId || testOrderNumber === 'W1234567890') {
      console.log('⏭️  跳过完整流程测试（请在 .env 中配置真实订单信息）');
      console.log('   需要配置: TEST_ORDER_NUMBER 和 TEST_APPLE_ID');
      return;
    }

    // 1. 创建测试订单
    console.log('📝 创建测试订单...');

    const appleId = await AppleId.findOrCreate({
      where: { appleId: testAppleId },
      defaults: { appleId: testAppleId, password: '', status: 'active' },
      transaction,
    });

    const recipient = await Recipient.findOrCreate({
      where: { idCardLast4: '1234' },
      defaults: {
        lastName: '测试',
        firstName: '用户',
        idCardNumber: '110101199001011234',
        idCardLast4: '1234',
      },
      transaction,
    });

    const order = await Order.create(
      {
        orderNumber: testOrderNumber,
        appleIdId: appleId[0].id,
        recipientId: recipient[0].id,
        products: [
          {
            model: 'UNKNOWN',
            name: '待爬取',
            quantity: 1,
          },
        ],
        paymentMethod: 'test',
        status: 'pending',
        source: 'test',
      },
      { transaction }
    );

    await transaction.commit();
    console.log(`✅ 测试订单创建成功 (ID: ${order.id})`);

    // 2. 初始化代理池（如果启用）
    if (process.env.PROXY_ENABLED === 'true') {
      console.log('🔄 初始化代理池...');
      await proxyManager.initialize();
    }

    // 3. 执行爬取和更新
    console.log('🕷️  开始爬取并更新订单...');
    const result = await crawlerService.crawlAndUpdateOrder(order.id);

    console.log('\n✅ 爬取更新成功!');
    console.log('\n📦 更新结果:');
    console.log(JSON.stringify(result, null, 2));

    // 4. 查询更新后的订单
    const updatedOrder = await Order.findByPk(order.id, {
      include: ['appleAccount', 'recipient'],
    });

    console.log('\n📦 最终订单数据:');
    console.log(`   订单号: ${updatedOrder.orderNumber}`);
    console.log(`   状态: ${updatedOrder.status}`);
    console.log(`   取机门店: ${updatedOrder.pickupStore}`);
    console.log(`   商品数量: ${updatedOrder.products.length}`);

    updatedOrder.products.forEach((product, index) => {
      console.log(`\n   商品 ${index + 1}:`);
      console.log(`     - 名称: ${product.name}`);
      console.log(`     - 型号: ${product.model}`);
      console.log(`     - 数量: ${product.quantity}`);
      console.log(`     - 状态: ${product.status || 'unknown'}`);
    });

    console.log('\n✅ 测试 4 通过\n');

    // 注意：不自动删除测试数据，方便手动检查
    console.log('⚠️  测试订单已保留在数据库中，请手动清理');
  } catch (error) {
    await transaction.rollback();
    console.error('❌ 测试 4 失败:', error.message);
    logger.error('测试 4 失败', { error: error.message, stack: error.stack });
  }
}

/**
 * 主测试函数
 */
async function runTests() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║        Apple 订单爬虫服务 - 测试套件                ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  try {
    // 测试数据库连接
    console.log('\n🔌 测试数据库连接...');
    await sequelize.authenticate();
    console.log('✅ 数据库连接成功');

    // 运行测试
    await testExtractAndParse();
    await testRealCrawl();
    await testDatabaseUpdate();
    await testFullCrawlAndUpdate();

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║              所有测试执行完成                        ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    console.log('📋 测试总结:');
    console.log('   - 测试 1: JSON 提取和解析');
    console.log('   - 测试 2: 真实订单爬取');
    console.log('   - 测试 3: 数据库更新');
    console.log('   - 测试 4: 完整流程测试');
    console.log('\n💡 提示:');
    console.log('   - 测试 2 和 4 需要在 .env 中配置真实订单信息');
    console.log('   - 配置项: TEST_ORDER_NUMBER 和 TEST_APPLE_ID');
    console.log('   - 测试 HTML 文件路径: test/fixtures/order_page.html\n');
  } catch (error) {
    console.error('\n❌ 测试执行出错:', error.message);
    logger.error('测试执行出错', { error: error.message, stack: error.stack });
    process.exit(1);
  } finally {
    // 关闭数据库连接
    await sequelize.close();
  }
}

// 运行测试
runTests();
