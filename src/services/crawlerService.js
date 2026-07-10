/**
 * 订单爬虫服务模块
 * 功能：爬取 Apple 官网订单详情，提取订单状态、商品信息、取机门店等数据
 *
 * 代理使用策略：
 * - 所有爬虫功能必须使用代理（防止 IP 被 Apple 风控）
 * - 失败计数累积，连续失败 2 次永久废弃代理
 * - HTTP 541 风控立即废弃代理
 *
 * 作者：Seraph
 * 更新：2026-07-08
 */

const axios = require('axios');
const cheerio = require('cheerio');

const logger = require('../utils/logger');
const proxyManager = require('../utils/proxyManager');
const { removeControlCharacters } = require('../utils/helpers');
const { Order, CrawlLog, sequelize } = require('../models');
const { config } = require('../utils/config');

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 生成随机延迟时间（5-10秒）
 * @returns {number} 延迟毫秒数
 */
function getRandomDelay() {
  return Math.floor(Math.random() * 5000) + 5000; // 5000-10000ms
}

/**
 * 获取订单页面 HTML
 * @param {string} orderUrl - 订单详情页 URL
 * @param {Object|null} proxy - 代理配置对象
 * @returns {Promise<string>} HTML 内容
 * @throws {Error} 当请求失败时抛出异常
 */
async function fetchOrderPage(orderUrl, proxy = null) {
  const config = {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Connection: 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
    timeout: 30000,
  };

  // 使用代理
  if (proxy) {
    config.proxy = {
      host: proxy.host,
      port: proxy.port,
      protocol: 'http',
    };

    // 如果有认证信息
    if (proxy.auth) {
      config.proxy.auth = proxy.auth;
    }

    logger.debug('使用代理请求订单页面', {
      url: orderUrl,
      proxy: `${proxy.host}:${proxy.port}`,
    });
  }

  try {
    const response = await axios.get(orderUrl, config);
    return response.data;
  } catch (error) {
    // 记录详细错误信息
    const errorInfo = {
      url: orderUrl,
      statusCode: error.response?.status,
      statusText: error.response?.statusText,
      message: error.message,
    };

    logger.error('请求订单页面失败', errorInfo);
    throw error;
  }
}

/**
 * 从 HTML 中提取订单 JSON 数据
 * @param {string} html - 订单页面 HTML
 * @returns {Object|null} 订单 JSON 对象，未找到返回 null
 */
function extractOrderJson(html) {
  try {
    const $ = cheerio.load(html);
    let orderJson = null;

    // 遍历所有 script 标签
    $('script').each((i, elem) => {
      const scriptContent = $(elem).html();

      // 查找包含 orderItem- 关键字的 script 标签
      if (scriptContent && scriptContent.includes('orderItem-')) {
        try {
          // 清理控制字符
          const cleaned = removeControlCharacters(scriptContent.trim())
            .replace(/\n/g, ' ')
            .replace(/\r/g, '')
            .replace(/\t/g, ' ');

          // 尝试解析 JSON
          orderJson = JSON.parse(cleaned);
          return false; // 找到后停止遍历
        } catch (e) {
          // JSON 解析失败，继续查找下一个
          logger.debug('JSON 解析失败，继续查找', {
            scriptIndex: i,
            error: e.message,
          });
        }
      }
    });

    if (!orderJson) {
      logger.warn('未在 HTML 中找到订单 JSON 数据');
    }

    return orderJson;
  } catch (error) {
    logger.error('提取订单 JSON 失败', {
      error: error.message,
      stack: error.stack,
    });
    return null;
  }
}

/**
 * 解析订单 JSON 数据为结构化对象
 * @param {Object} orderJson - 订单 JSON 对象
 * @param {string} html - 原始 HTML（用于提取页面文本信息）
 * @returns {Object} 解析后的订单数据
 */
function parseOrderData(orderJson, html) {
  try {
    const $ = cheerio.load(html);
    const bodyText = $('body').text();

    // 1. 提取订单基本信息
    const orderHeader = orderJson.orderDetail?.orderHeader?.d || {};
    const orderNumber = orderHeader.orderNumber || null;
    const orderPlacedDate = orderHeader.orderPlacedDate || null;

    // 日期格式转换: "2025年11月8日" → "2025-11-08"
    let orderDate = null;
    if (orderPlacedDate) {
      const dateMatch = orderPlacedDate.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (dateMatch) {
        orderDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
      }
    }

    // 2. 提取订单状态（从页面文本）
    let orderStatus = 'unknown';
    const statusKeywords = {
      取货已取消: 'pickup_cancelled',
      已取消: 'cancelled',
      准备就绪: 'ready_for_pickup',
      处理中: 'processing',
      已发货: 'shipped',
      已送达: 'delivered',
    };

    for (const [keyword, status] of Object.entries(statusKeywords)) {
      if (bodyText.includes(keyword)) {
        orderStatus = status;
        break;
      }
    }

    // 3. 提取商品列表
    const orderItems = orderJson.orderDetail?.orderItems || {};
    const products = [];

    Object.keys(orderItems).forEach((key) => {
      if (key.startsWith('orderItem-') && key.match(/orderItem-\d+/)) {
        const item = orderItems[key];
        const itemDetails = item.orderItemDetails?.d;
        const itemStatus = item.orderItemStatusTracker?.d;

        if (itemDetails) {
          // 提取商品型号 - 尝试多种可能的字段名
          let model = itemDetails.partNumber ||
                     itemDetails.sku ||
                     itemDetails.productId ||
                     itemDetails.modelNumber || '';

          // ⚠️ Apple 官网订单详情页不包含型号字段
          // 型号只能从邮件中的商品字符串提取（格式：MG714CH/A-商品名）
          // 这里将 model 留空，由邮件解析器填充
          logger.debug('商品信息提取', {
            name: itemDetails.productName,
            quantity: itemDetails.quantity,
            modelFromJson: model || '(JSON中无型号字段)',
          });

          products.push({
            name: itemDetails.productName || '',
            model: model, // 通常为空，由邮件解析填充
            quantity: itemDetails.quantity || 0,
            status: itemStatus?.currentStatus || 'unknown',
            deliveryType: item.d?.deliveryType || 'unknown',
            imageUrl: itemDetails.imageData?.src || null,
            pickupType: itemDetails.pickupType || null,
            deliveryDate: itemDetails.deliveryDate || null,
          });
        }
      }
    });

    // 4. 提取取机门店信息
    let pickupStore = null;
    let storeDirectionsUrl = null;

    // 从第一个商品的配送信息中提取门店
    const firstItemKey = orderItems.c?.[0];
    if (firstItemKey) {
      const firstItem = orderItems[firstItemKey];
      const storeInfo = firstItem?.shippingInfo?.['shipping-address']?.address?.d;

      pickupStore = storeInfo?.companyName || null;
      storeDirectionsUrl = firstItem?.orderItemDetails?.d?.hoursAndDirectionsURL || null;
    }

    // 5. 从页面文本中提取门店（备用方案）
    if (!pickupStore) {
      const storeRegex = /店内取货地点[：:]\s*(Apple\s+[一-龥\w]+)/;
      const storeMatch = bodyText.match(storeRegex);
      if (storeMatch) {
        pickupStore = storeMatch[1].trim();
      }
    }

    return {
      orderNumber,
      orderDate,
      orderStatus,
      products,
      pickupStore,
      storeDirectionsUrl,
      rawJson: orderJson,
    };
  } catch (error) {
    logger.error('解析订单数据失败', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * 带重试的爬取函数
 * @param {string} orderUrl - 订单详情页 URL
 * @param {number} maxRetries - 最大重试次数
 * @returns {Promise<Object>} 爬取结果
 * @throws {Error} 当所有重试都失败时抛出异常
 */
async function fetchWithRetry(orderUrl, maxRetries = 3) {
  // 检查代理是否启用
  if (!config.proxy.enabled) {
    throw new Error('爬虫服务必须启用代理池（请设置 PROXY_ENABLED=true）');
  }

  let lastError;
  let currentProxy = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 获取代理
      currentProxy = proxyManager.getNextProxy();

      if (!currentProxy) {
        // ✅ 只有在代理池耗尽时才刷新
        logger.warn('代理池已耗尽，尝试刷新获取新代理');
        try {
          await proxyManager.refresh();
          currentProxy = proxyManager.getNextProxy();

          if (!currentProxy) {
            throw new Error('刷新代理池后仍无可用代理');
          }
        } catch (refreshError) {
          logger.error('刷新代理池失败', { error: refreshError.message });
          throw new Error('无可用代理且刷新失败');
        }
      }

      logger.info('开始爬取订单', {
        url: orderUrl,
        attempt,
        maxRetries,
        proxy: `${currentProxy.host}:${currentProxy.port}`,
      });

      // 发送请求
      const html = await fetchOrderPage(orderUrl, currentProxy);

      // 提取 JSON 数据
      const orderJson = extractOrderJson(html);

      if (!orderJson) {
        throw new Error('无法提取订单 JSON 数据');
      }

      // 解析订单数据
      const orderData = parseOrderData(orderJson, html);

      // ✅ 成功：记录成功（不重置失败计数）
      proxyManager.recordProxySuccess(currentProxy);

      logger.info('订单爬取成功', {
        orderNumber: orderData.orderNumber,
        status: orderData.orderStatus,
        productCount: orderData.products.length,
        proxy: `${currentProxy.host}:${currentProxy.port}`,
      });

      return {
        success: true,
        data: orderData,
        proxy: `${currentProxy.host}:${currentProxy.port}`,
      };
    } catch (error) {
      lastError = error;

      logger.warn('订单爬取失败', {
        attempt,
        maxRetries,
        error: error.message,
        statusCode: error.response?.status,
        proxy: currentProxy ? `${currentProxy.host}:${currentProxy.port}` : 'none',
      });

      if (currentProxy) {
        // HTTP 541: Apple 风控，立即永久废弃
        if (error.response?.status === 541) {
          logger.warn('检测到 Apple 风控（HTTP 541），立即废弃代理');
          proxyManager.markProxyAsBad(currentProxy);
          // ✅ 修复：不在这里刷新，重试时会自动从池中获取下一个代理
          // 只有当 getNextProxy() 返回 null 时，才需要刷新
        }
        // 其他错误：累计失败次数
        else {
          const isDiscarded = proxyManager.recordProxyFailure(currentProxy);

          if (isDiscarded) {
            logger.info('代理已永久废弃，下次重试将获取新代理', {
              discardedProxy: `${currentProxy.host}:${currentProxy.port}`,
            });
          }
        }
      }

      // 如果还有重试机会，延时后重试
      if (attempt < maxRetries) {
        const delay = getRandomDelay() * attempt; // 递增延时
        logger.info('等待后重试', {
          delaySeconds: (delay / 1000).toFixed(1),
          nextAttempt: attempt + 1,
        });
        await sleep(delay);
      }
    }
  }

  // 所有重试都失败
  throw new Error(`爬取订单失败，已重试 ${maxRetries} 次: ${lastError.message}`);
}

/**
 * 爬取订单并更新数据库
 * @param {number} orderId - 订单 ID
 * @returns {Promise<Object>} 更新结果
 * @throws {Error} 当爬取或更新失败时抛出异常
 */
async function crawlAndUpdateOrder(orderId) {
  const transaction = await sequelize.transaction();
  const startTime = Date.now();

  try {
    // 1. 查询订单信息
    const order = await Order.findByPk(orderId, {
      include: [
        {
          association: 'appleAccount',
          attributes: ['appleId'],
        },
      ],
    });

    if (!order) {
      throw new Error(`订单不存在: ID ${orderId}`);
    }

    if (!order.orderNumber) {
      throw new Error('订单号缺失，无法构建爬取 URL');
    }

    if (!order.appleAccount?.appleId) {
      throw new Error('Apple ID 缺失，无法构建爬取 URL');
    }

    // 2. 构建订单详情页 URL
    const orderUrl = `https://www.apple.com.cn/xc/cn/vieworder/${order.orderNumber}/${order.appleAccount.appleId}`;

    logger.info('开始爬取订单数据', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      url: orderUrl,
    });

    // 3. 爬取订单数据（带重试）
    const crawlResult = await fetchWithRetry(orderUrl);
    const { data: crawledData, proxy } = crawlResult;

    // 4. 更新订单数据
    const updateData = {
      status: crawledData.orderStatus,
      crawledData: crawledData.rawJson, // 存储原始 JSON 到 JSONB 字段
      pickupStore: crawledData.pickupStore,
      lastCrawledAt: new Date(),
    };

    // 更新下单日期（如果爬取到）
    if (crawledData.orderDate) {
      updateData.orderDate = crawledData.orderDate;
    }

    // 更新商品信息（合并邮件数据和爬取数据）
    if (crawledData.products.length > 0) {
      updateData.products = order.products.map((emailProduct) => {
        // 尝试通过型号匹配爬取的商品
        const crawledProduct = crawledData.products.find(
          (p) => p.model === emailProduct.model || p.name.includes(emailProduct.name)
        );

        if (crawledProduct) {
          return {
            ...emailProduct,
            // 保留邮件中的数量（权威）
            quantity: emailProduct.quantity,
            // 更新爬取的信息
            status: crawledProduct.status,
            imageUrl: crawledProduct.imageUrl,
            deliveryType: crawledProduct.deliveryType,
          };
        }

        return emailProduct;
      });
    }

    await order.update(updateData, { transaction });

    // 5. 记录爬取日志
    const responseTime = Date.now() - startTime;
    await CrawlLog.create(
      {
        orderId: order.id,
        proxyIp: proxy,
        success: true,
        responseTime,
        errorMessage: null,
      },
      { transaction }
    );

    await transaction.commit();

    logger.info('订单数据更新成功', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: crawledData.orderStatus,
      responseTime,
    });

    return {
      success: true,
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: crawledData.orderStatus,
      productCount: crawledData.products.length,
      pickupStore: crawledData.pickupStore,
      responseTime,
    };
  } catch (error) {
    await transaction.rollback();

    // 记录失败日志
    try {
      const responseTime = Date.now() - startTime;
      await CrawlLog.create({
        orderId,
        proxyIp: null,
        success: false,
        responseTime,
        errorMessage: error.message,
      });
    } catch (logError) {
      logger.error('记录爬取日志失败', {
        error: logError.message,
      });
    }

    logger.error('订单爬取更新失败', {
      orderId,
      error: error.message,
      stack: error.stack,
    });

    throw error;
  }
}

/**
 * 批量爬取并更新多个订单
 * @param {Array<number>} orderIds - 订单 ID 数组
 * @param {Object} options - 配置选项
 * @param {number} options.concurrency - 并发数（默认 1，防止触发风控）
 * @param {number} options.delayBetween - 订单之间的延迟毫秒数（默认 5000-10000 随机）
 * @returns {Promise<Object>} 批量爬取结果
 */
async function crawlMultipleOrders(orderIds, options = {}) {
  const { concurrency = 1, delayBetween = null } = options;

  const results = {
    total: orderIds.length,
    success: 0,
    failed: 0,
    details: [],
  };

  logger.info('开始批量爬取订单', {
    total: orderIds.length,
    concurrency,
  });

  for (let i = 0; i < orderIds.length; i++) {
    const orderId = orderIds[i];

    try {
      const result = await crawlAndUpdateOrder(orderId);
      results.success++;
      results.details.push({
        orderId,
        success: true,
        result,
      });
    } catch (error) {
      results.failed++;
      results.details.push({
        orderId,
        success: false,
        error: error.message,
      });
    }

    // 在订单之间添加延迟（防止触发风控）
    if (i < orderIds.length - 1) {
      const delay = delayBetween || getRandomDelay();
      logger.info('等待后处理下一个订单', {
        delaySeconds: (delay / 1000).toFixed(1),
        processed: i + 1,
        remaining: orderIds.length - i - 1,
      });
      await sleep(delay);
    }
  }

  logger.info('批量爬取完成', {
    total: results.total,
    success: results.success,
    failed: results.failed,
  });

  return results;
}

module.exports = {
  fetchOrderPage,
  extractOrderJson,
  parseOrderData,
  fetchWithRetry,
  crawlAndUpdateOrder,
  crawlMultipleOrders,
  sleep,
  getRandomDelay,
};
