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
const { Op } = require('sequelize');

const logger = require('../utils/logger');
const proxyManager = require('../utils/proxyManager');
const { removeControlCharacters } = require('../utils/helpers');
const { Order, CrawlLog, sequelize } = require('../models');
const { config } = require('../utils/config');
const { sendTelegramAlert } = require('../utils/telegramNotifier');

const AUTO_STOP_STATUSES = new Set([
  'completed',
  'cancelled',
  'pickup_cancelled',
  'delivered',
]);
const AUTO_STOP_PAYMENT_PICKUP = {
  paymentStatus: 'paid',
  pickupStatus: 'not_picked_up',
};
const VALIDATION_STATUS = {
  UNCHECKED: 'unchecked',
  VALID: 'valid',
  ABNORMAL: 'abnormal',
  UNAVAILABLE: 'unavailable',
};
const schedulerState = {
  isRunning: false,
  isScanning: false,
  isPaused: false,
  pausedAt: null,
  pauseReason: null,
  lastScanAt: null,
  nextScanAt: null,
  consecutiveWindControlCount: 0,
  timer: null,
};

/**
 * 构造安全 URL 摘要，避免日志记录 Apple ID 邮箱
 * @param {string} orderUrl - Apple 订单 URL
 * @returns {Object} URL 摘要
 */
function summarizeOrderUrl(orderUrl) {
  try {
    const parsedUrl = new URL(orderUrl);
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    const orderNumber = pathParts.find((part) => /^W\d{10}$/.test(part)) || null;
    return {
      host: parsedUrl.host,
      orderNumber,
    };
  } catch (error) {
    logger.warn('订单 URL 摘要解析失败', { error: error.message });
    return {
      host: null,
      orderNumber: null,
    };
  }
}

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
 * 标准化文本以便商品匹配
 * @param {string|null|undefined} value - 原始文本
 * @returns {string} 标准化文本
 */
function normalizeProductText(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[，,，。]/g, '')
    .toLowerCase();
}

/**
 * 从文本中解析金额
 * @param {string} value - 待解析文本
 * @returns {Object|null} 金额对象
 */
function parseAmountFromText(value) {
  try {
    const amountMatch = String(value || '').match(/(?:RMB|CNY|¥|￥)\s*([0-9,]+(?:\.\d{1,2})?)/i);
    if (!amountMatch) {
      return null;
    }

    const amount = Number(amountMatch[1].replace(/,/g, ''));
    if (Number.isNaN(amount)) {
      return null;
    }

    return {
      amount,
      currency: value.includes('RMB') ? 'RMB' : 'CNY',
    };
  } catch (error) {
    logger.error('解析金额文本失败', { error: error.message });
    return null;
  }
}

/**
 * 从页面文本中解析订单总金额
 * @param {string} bodyText - 页面文本
 * @returns {Object} 解析结果
 */
function extractOfficialAmount(bodyText) {
  try {
    const normalizedText = String(bodyText || '').replace(/\s+/g, ' ');
    const candidates = [
      /订单总计[^¥￥RMB CNY]{0,20}((?:RMB|CNY|¥|￥)\s*[0-9,]+(?:\.\d{1,2})?)/i,
      /总计[^¥￥RMB CNY]{0,20}((?:RMB|CNY|¥|￥)\s*[0-9,]+(?:\.\d{1,2})?)/i,
      /合计[^¥￥RMB CNY]{0,20}((?:RMB|CNY|¥|￥)\s*[0-9,]+(?:\.\d{1,2})?)/i,
    ];

    for (const pattern of candidates) {
      const match = normalizedText.match(pattern);
      if (match) {
        const parsedAmount = parseAmountFromText(match[1]);
        if (parsedAmount) {
          return {
            ...parsedAmount,
            parseError: null,
          };
        }
      }
    }

    return {
      amount: null,
      currency: null,
      parseError: '页面未出现可识别的订单总金额',
    };
  } catch (error) {
    logger.error('解析官网订单金额失败', { error: error.message });
    return {
      amount: null,
      currency: null,
      parseError: error.message,
    };
  }
}

/**
 * 从页面文本中推断支付状态
 * @param {string} bodyText - 页面文本
 * @param {string|null} orderStatus - 订单状态
 * @returns {string|null} 标准支付状态
 */
function inferPaymentStatus(bodyText, orderStatus = null) {
  const text = String(bodyText || '');
  if (/已付款|支付成功|已支付/.test(text)) {
    return 'paid';
  }
  if (/待付款|等待付款|未付款/.test(text)) {
    return 'unpaid';
  }
  if (/退款|已退款/.test(text)) {
    return 'refunded';
  }
  if (['ready_for_pickup', 'completed', 'delivered'].includes(orderStatus)) {
    return 'paid';
  }
  return null;
}

/**
 * 从页面文本中推断取货状态
 * @param {string} bodyText - 页面文本
 * @param {string|null} orderStatus - 订单状态
 * @returns {string|null} 标准取货状态
 */
function inferPickupStatus(bodyText, orderStatus = null) {
  const text = String(bodyText || '');
  if (/已取货/.test(text)) {
    return 'picked_up';
  }
  if (/取货已取消/.test(text)) {
    return 'pickup_cancelled';
  }
  if (/准备就绪|可取货|待取货|未取货/.test(text)) {
    return 'not_picked_up';
  }
  if (orderStatus === 'ready_for_pickup') {
    return 'not_picked_up';
  }
  if (['completed', 'delivered'].includes(orderStatus)) {
    return 'picked_up';
  }
  if (orderStatus === 'pickup_cancelled') {
    return 'pickup_cancelled';
  }
  return null;
}

/**
 * 比对邮件商品和官网商品
 * @param {Array<Object>} emailProducts - 邮件导入商品
 * @param {Array<Object>} officialProducts - 官网商品
 * @returns {Object} 校验结果
 */
function validateProducts(emailProducts = [], officialProducts = []) {
  try {
    if (!Array.isArray(officialProducts) || officialProducts.length === 0) {
      return {
        status: VALIDATION_STATUS.UNAVAILABLE,
        issues: [{
          type: 'official_products_missing',
          message: '官网商品信息为空，无法完成交叉验证',
        }],
        comparisons: [],
      };
    }

    const matchedOfficialIndexes = new Set();
    const issues = [];
    const comparisons = emailProducts.map((emailProduct) => {
      const emailModel = normalizeProductText(emailProduct.model || emailProduct.modelId);
      const emailName = normalizeProductText(emailProduct.name);

      const officialIndex = officialProducts.findIndex((officialProduct, index) => {
        if (matchedOfficialIndexes.has(index)) {
          return false;
        }

        const officialModel = normalizeProductText(officialProduct.model || officialProduct.modelId);
        const officialName = normalizeProductText(officialProduct.name);

        if (emailModel && officialModel && emailModel === officialModel) {
          return true;
        }

        return emailName &&
          officialName &&
          (officialName.includes(emailName) || emailName.includes(officialName));
      });

      if (officialIndex === -1) {
        const issue = {
          type: 'product_missing_on_official',
          model: emailProduct.model || emailProduct.modelId || null,
          name: emailProduct.name || null,
          message: '邮件商品未在官网商品列表中匹配到',
        };
        issues.push(issue);
        return {
          model: emailProduct.model || emailProduct.modelId || null,
          name: emailProduct.name || null,
          emailQuantity: Number(emailProduct.quantity || 0),
          officialQuantity: null,
          result: 'abnormal',
          issue: issue.message,
        };
      }

      matchedOfficialIndexes.add(officialIndex);
      const officialProduct = officialProducts[officialIndex];
      const emailQuantity = Number(emailProduct.quantity || 0);
      const officialQuantity = Number(officialProduct.quantity || 0);
      const isQuantityMatched = emailQuantity === officialQuantity;

      if (!isQuantityMatched) {
        issues.push({
          type: 'quantity_mismatch',
          model: emailProduct.model || emailProduct.modelId || officialProduct.model || null,
          name: emailProduct.name || officialProduct.name || null,
          emailQuantity,
          officialQuantity,
          message: '邮件商品数量与官网商品数量不一致',
        });
      }

      return {
        model: emailProduct.model || emailProduct.modelId || officialProduct.model || null,
        name: emailProduct.name || officialProduct.name || null,
        emailQuantity,
        officialQuantity,
        result: isQuantityMatched ? 'valid' : 'abnormal',
        issue: isQuantityMatched ? null : '数量不一致',
      };
    });

    officialProducts.forEach((officialProduct, index) => {
      if (!matchedOfficialIndexes.has(index)) {
        issues.push({
          type: 'unexpected_official_product',
          model: officialProduct.model || officialProduct.modelId || null,
          name: officialProduct.name || null,
          officialQuantity: Number(officialProduct.quantity || 0),
          message: '官网存在邮件中未导入的商品',
        });
      }
    });

    return {
      status: issues.length > 0 ? VALIDATION_STATUS.ABNORMAL : VALIDATION_STATUS.VALID,
      issues,
      comparisons,
    };
  } catch (error) {
    logger.error('商品交叉验证失败', { error: error.message });
    return {
      status: VALIDATION_STATUS.ABNORMAL,
      issues: [{ type: 'validation_error', message: error.message }],
      comparisons: [],
    };
  }
}

/**
 * 判断订单是否应停止自动刷新
 * @param {Object} orderLike - 订单数据
 * @returns {string|null} 停止原因
 */
function getAutoRefreshStopReason(orderLike) {
  const status = orderLike.status || orderLike.orderStatus;
  if (AUTO_STOP_STATUSES.has(status)) {
    return `status:${status}`;
  }
  if (status === 'ready_for_pickup') {
    return 'status:ready_for_pickup';
  }
  if (
    orderLike.paymentStatus === AUTO_STOP_PAYMENT_PICKUP.paymentStatus &&
    orderLike.pickupStatus === AUTO_STOP_PAYMENT_PICKUP.pickupStatus
  ) {
    return 'paid_not_picked_up';
  }
  if (orderLike.validationStatus === VALIDATION_STATUS.ABNORMAL) {
    return 'validation_abnormal';
  }
  return null;
}

/**
 * 记录结构化爬虫/系统日志
 * @param {Object} logData - 日志数据
 * @returns {Promise<Object|null>} 日志记录
 */
async function createCrawlLog(logData) {
  try {
    return await CrawlLog.create({
      orderId: logData.orderId || null,
      source: logData.source || 'system',
      severity: logData.severity || 'info',
      eventType: logData.eventType || 'crawler',
      event: logData.event || null,
      proxyIp: logData.proxyIp || null,
      success: Boolean(logData.success),
      responseTime: logData.responseTime || null,
      httpStatus: logData.httpStatus || null,
      errorMessage: logData.errorMessage || null,
      errorStack: logData.errorStack || null,
      crawledData: logData.crawledData || null,
      context: logData.context || null,
      result: logData.result || null,
      isWindControl: Boolean(logData.isWindControl),
      retryCount: logData.retryCount || 0,
    });
  } catch (error) {
    logger.error('记录爬虫日志失败', { error: error.message });
    return null;
  }
}

/**
 * 暂停自动刷新
 * @param {string} reason - 暂停原因
 * @param {Object} context - 上下文
 * @returns {Promise<void>}
 */
async function pauseAutoRefresh(reason, context = {}) {
  try {
    if (schedulerState.isPaused) {
      return;
    }

    schedulerState.isPaused = true;
    schedulerState.pausedAt = new Date();
    schedulerState.pauseReason = reason;

    logger.error('自动刷新已暂停', {
      reason,
      context,
    });

    await createCrawlLog({
      source: 'system',
      severity: 'error',
      eventType: 'wind_control',
      event: 'auto_refresh_paused',
      success: false,
      isWindControl: true,
      errorMessage: reason,
      context,
      result: 'paused',
    });

    await sendTelegramAlert('自动刷新已暂停', {
      reason,
      ...context,
    });
  } catch (error) {
    logger.error('暂停自动刷新失败', { error: error.message });
  }
}

/**
 * 代理不可用时暂停自动刷新并告警
 * @param {string} reason - 暂停原因
 * @param {Object} context - 上下文
 * @returns {Promise<void>}
 */
async function pauseAutoRefreshForProxyFailure(reason, context = {}) {
  try {
    await pauseAutoRefresh(reason, context);
    await createCrawlLog({
      source: 'system',
      severity: 'error',
      eventType: 'proxy',
      event: 'auto_refresh_paused_by_proxy',
      success: false,
      errorMessage: reason,
      context,
      result: 'paused',
    });
  } catch (error) {
    logger.error('代理异常暂停自动刷新失败', { error: error.message });
  }
}

/**
 * 管理员恢复自动刷新
 * @param {Object} operator - 操作人
 * @returns {Promise<Object>} 当前状态
 */
async function resumeAutoRefresh(operator = {}) {
  try {
    schedulerState.isPaused = false;
    schedulerState.pausedAt = null;
    schedulerState.pauseReason = null;
    schedulerState.consecutiveWindControlCount = 0;

    await createCrawlLog({
      source: 'system',
      severity: 'info',
      eventType: 'scheduler',
      event: 'auto_refresh_resumed',
      success: true,
      context: {
        operatorId: operator.id,
        operatorName: operator.username,
      },
      result: 'resumed',
    });

    logger.info('自动刷新已恢复', {
      operatorId: operator.id,
      operatorName: operator.username,
    });

    return getAutoRefreshStatus();
  } catch (error) {
    logger.error('恢复自动刷新失败', { error: error.message });
    throw error;
  }
}

/**
 * 获取自动刷新状态
 * @returns {Object} 自动刷新状态
 */
function getAutoRefreshStatus() {
  return {
    enabled: config.crawler.autoRefreshEnabled,
    isRunning: schedulerState.isRunning,
    isPaused: schedulerState.isPaused,
    pausedAt: schedulerState.pausedAt,
    pauseReason: schedulerState.pauseReason,
    lastScanAt: schedulerState.lastScanAt,
    nextScanAt: schedulerState.nextScanAt,
    intervalMs: config.crawler.autoRefreshIntervalMs,
    consecutiveWindControlCount: schedulerState.consecutiveWindControlCount,
  };
}

/**
 * 获取订单页面 HTML
 * @param {string} orderUrl - 订单详情页 URL
 * @param {Object|null} proxy - 代理配置对象
 * @returns {Promise<string>} HTML 内容
 * @throws {Error} 当请求失败时抛出异常
 */
async function fetchOrderPage(orderUrl, proxy = null) {
  const requestConfig = {
    headers: {
      'User-Agent': config.crawler.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Connection: 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
    timeout: config.crawler.timeout,
  };

  // 使用代理
  if (proxy) {
    requestConfig.proxy = {
      host: proxy.host,
      port: proxy.port,
      protocol: 'http',
    };

    // 如果有认证信息
    if (proxy.auth) {
      requestConfig.proxy.auth = proxy.auth;
    }

    logger.debug('使用代理请求订单页面', {
      urlSummary: summarizeOrderUrl(orderUrl),
      proxy: `${proxy.host}:${proxy.port}`,
    });
  }

  try {
    const response = await axios.get(orderUrl, requestConfig);
    return response.data;
  } catch (error) {
    // 记录详细错误信息
    const errorInfo = {
      urlSummary: summarizeOrderUrl(orderUrl),
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
      已取货: 'completed',
      取货已取消: 'pickup_cancelled',
      已取消: 'cancelled',
      已送达: 'delivered',
      准备就绪: 'ready_for_pickup',
      可取货: 'ready_for_pickup',
      处理中: 'processing',
      已发货: 'shipped',
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
          products.push({
            name: itemDetails.productName || '',
            model: itemDetails.partNumber ||
              itemDetails.sku ||
              itemDetails.productId ||
              itemDetails.modelNumber ||
              '',
            quantity: itemDetails.quantity || 0,
            status: itemStatus?.currentStatus || 'unknown',
            deliveryType: item.d?.deliveryType || 'unknown',
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

    const amountResult = extractOfficialAmount(bodyText);

    return {
      orderNumber,
      orderDate,
      orderStatus,
      paymentStatus: inferPaymentStatus(bodyText, orderStatus),
      pickupStatus: inferPickupStatus(bodyText, orderStatus),
      products,
      pickupStore,
      storeDirectionsUrl,
      officialOrderAmount: amountResult.amount,
      officialOrderAmountCurrency: amountResult.currency,
      officialOrderAmountParseError: amountResult.parseError,
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
    const error = new Error('爬虫服务必须启用代理池（请设置 PROXY_ENABLED=true）');
    error.eventType = 'proxy';
    throw error;
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
        } catch (refreshError) {
          logger.error('刷新代理池失败', { error: refreshError.message });
          const proxyError = new Error('无可用代理且刷新失败');
          proxyError.eventType = 'proxy';
          proxyError.urlSummary = summarizeOrderUrl(orderUrl);
          await pauseAutoRefreshForProxyFailure('代理池耗尽或代理 API 失败', {
            urlSummary: proxyError.urlSummary,
            attempt,
            refreshError: refreshError.message,
            proxyStatus: proxyManager.getStatus(),
          });
          throw proxyError;
        }

        currentProxy = proxyManager.getNextProxy();

        if (!currentProxy) {
          const noProxyError = new Error('刷新代理池后仍无可用代理');
          noProxyError.eventType = 'proxy';
          noProxyError.urlSummary = summarizeOrderUrl(orderUrl);
          await pauseAutoRefreshForProxyFailure('代理池耗尽', {
            urlSummary: noProxyError.urlSummary,
            attempt,
            proxyStatus: proxyManager.getStatus(),
          });
          throw noProxyError;
        }
      }

      logger.info('开始爬取订单', {
        urlSummary: summarizeOrderUrl(orderUrl),
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
      schedulerState.consecutiveWindControlCount = 0;

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
          schedulerState.consecutiveWindControlCount++;
          error.isWindControl = true;
          error.httpStatus = 541;
          error.proxyIp = `${currentProxy.host}:${currentProxy.port}`;
          error.eventType = 'wind_control';

          if (schedulerState.consecutiveWindControlCount >=
            config.crawler.windControlPauseThreshold) {
            await pauseAutoRefresh('连续触发 Apple 风控', {
              urlSummary: summarizeOrderUrl(orderUrl),
              proxyIp: error.proxyIp,
              consecutiveWindControlCount: schedulerState.consecutiveWindControlCount,
              threshold: config.crawler.windControlPauseThreshold,
            });
          }
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
  const retryError = new Error(`爬取订单失败，已重试 ${maxRetries} 次: ${lastError.message}`);
  retryError.isWindControl = Boolean(lastError.isWindControl);
  retryError.httpStatus = lastError.httpStatus || lastError.response?.status;
  retryError.proxyIp = lastError.proxyIp ||
    (currentProxy ? `${currentProxy.host}:${currentProxy.port}` : null);
  retryError.eventType = lastError.eventType || 'crawler';
  throw retryError;
}

/**
 * 爬取订单并更新数据库
 * @param {number} orderId - 订单 ID
 * @returns {Promise<Object>} 更新结果
 * @throws {Error} 当爬取或更新失败时抛出异常
 */
async function crawlAndUpdateOrder(orderId, options = {}) {
  const transaction = await sequelize.transaction();
  const startTime = Date.now();
  const source = options.source || (options.manual ? 'manual' : 'auto');

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

    if (!order.appleAccount?.appleId && !order.appleId) {
      throw new Error('Apple ID 缺失，无法构建爬取 URL');
    }

    // 2. 构建订单详情页 URL
    const appleId = order.appleAccount?.appleId || order.appleId;
    const orderUrl = order.orderUrl ||
      `https://www.apple.com.cn/xc/cn/vieworder/${order.orderNumber}/${appleId}`;

    logger.info('开始爬取订单数据', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      urlSummary: summarizeOrderUrl(orderUrl),
      source,
    });

    // 3. 爬取订单数据（带重试）
    const crawlResult = await fetchWithRetry(orderUrl);
    const { data: crawledData, proxy } = crawlResult;
    const validationResult = validateProducts(order.products, crawledData.products);
    const autoRefreshStopReason = getAutoRefreshStopReason({
      status: crawledData.orderStatus,
      paymentStatus: crawledData.paymentStatus,
      pickupStatus: crawledData.pickupStatus,
      validationStatus: validationResult.status,
    });

    // 4. 更新订单数据
    const updateData = {
      status: crawledData.orderStatus,
      paymentStatus: crawledData.paymentStatus,
      pickupStatus: crawledData.pickupStatus,
      pickupStore: crawledData.pickupStore,
      officialProducts: crawledData.products,
      officialOrderAmount: crawledData.officialOrderAmount,
      officialOrderAmountCurrency: crawledData.officialOrderAmountCurrency,
      officialOrderAmountParseError: crawledData.officialOrderAmountParseError,
      validationStatus: validationResult.status,
      validationIssues: validationResult.issues,
      anomalyDetectedAt:
        validationResult.status === VALIDATION_STATUS.ABNORMAL
          ? order.anomalyDetectedAt || new Date()
          : null,
      autoRefreshEnabled: !autoRefreshStopReason,
      autoRefreshStopReason: autoRefreshStopReason,
      autoRefreshStoppedAt: autoRefreshStopReason ? new Date() : null,
      lastCrawledAt: new Date(),
      crawlFailCount: 0,
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
            deliveryType: crawledProduct.deliveryType,
          };
        }

        return emailProduct;
      });
    }

    await order.update(updateData, { transaction });

    // 5. 记录爬取日志
    const responseTime = Date.now() - startTime;
    await CrawlLog.create({
      orderId: order.id,
      source,
      severity: validationResult.status === VALIDATION_STATUS.ABNORMAL ? 'warn' : 'info',
      eventType: validationResult.status === VALIDATION_STATUS.ABNORMAL
        ? 'product_validation'
        : 'crawler',
      event: validationResult.status === VALIDATION_STATUS.ABNORMAL
        ? 'order_marked_abnormal'
        : 'order_sync_success',
      proxyIp: proxy,
      success: true,
      responseTime,
      errorMessage: null,
      crawledData: crawledData.rawJson,
      context: {
        orderNumber: order.orderNumber,
        officialProductCount: crawledData.products.length,
        validationStatus: validationResult.status,
        validationIssues: validationResult.issues,
        amountParseError: crawledData.officialOrderAmountParseError,
        autoRefreshStopReason,
      },
      result: validationResult.status,
    }, { transaction });

    await transaction.commit();

    if (validationResult.status === VALIDATION_STATUS.ABNORMAL) {
      await sendTelegramAlert('订单商品校验异常', {
        orderNumber: order.orderNumber,
        issueCount: validationResult.issues.length,
        stopReason: autoRefreshStopReason,
      });
    }

    if (crawledData.officialOrderAmountParseError) {
      await createCrawlLog({
        orderId: order.id,
        source,
        severity: 'warn',
        eventType: 'amount_parse',
        event: 'official_amount_parse_missing',
        success: true,
        proxyIp: proxy,
        errorMessage: crawledData.officialOrderAmountParseError,
        context: {
          orderNumber: order.orderNumber,
        },
        result: 'amount_missing',
      });
    }

    logger.info('订单数据更新成功', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: crawledData.orderStatus,
      validationStatus: validationResult.status,
      responseTime,
    });

    return {
      success: true,
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: crawledData.orderStatus,
      productCount: crawledData.products.length,
      pickupStore: crawledData.pickupStore,
      paymentStatus: crawledData.paymentStatus,
      pickupStatus: crawledData.pickupStatus,
      officialOrderAmount: crawledData.officialOrderAmount,
      officialOrderAmountCurrency: crawledData.officialOrderAmountCurrency,
      validationStatus: validationResult.status,
      validationIssues: validationResult.issues,
      productComparisons: validationResult.comparisons,
      autoRefreshStopReason,
      responseTime,
    };
  } catch (error) {
    await transaction.rollback();

    // 记录失败日志
    const responseTime = Date.now() - startTime;
    await createCrawlLog({
      orderId,
      source,
      severity: error.isWindControl ? 'error' : 'warn',
      eventType: error.eventType || 'crawler',
      event: error.isWindControl ? 'wind_control_detected' : 'order_sync_failed',
      proxyIp: error.proxyIp || null,
      success: false,
      responseTime,
      httpStatus: error.httpStatus || error.response?.status || null,
      errorMessage: error.message,
      errorStack: error.stack,
      isWindControl: Boolean(error.isWindControl),
      context: {
        manual: Boolean(options.manual),
      },
      result: 'failed',
    });

    try {
      await Order.increment('crawlFailCount', { where: { id: orderId } });
    } catch (incrementError) {
      logger.error('更新爬取失败次数失败', {
        orderId,
        error: incrementError.message,
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
      const result = await crawlAndUpdateOrder(orderId, {
        source: options.source || 'auto',
        manual: Boolean(options.manual),
      });
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

/**
 * 判断订单是否符合自动刷新条件
 * @param {Object} order - 订单实例或普通对象
 * @returns {boolean} 是否可自动刷新
 */
function isOrderEligibleForAutoRefresh(order) {
  try {
    const plain = typeof order.toJSON === 'function' ? order.toJSON() : order;
    if (!plain.autoRefreshEnabled) {
      return false;
    }
    if (!plain.orderUrl && !plain.orderNumber) {
      return false;
    }
    if (plain.validationStatus === VALIDATION_STATUS.ABNORMAL) {
      return false;
    }
    return !getAutoRefreshStopReason({
      status: plain.status,
      paymentStatus: plain.paymentStatus,
      pickupStatus: plain.pickupStatus,
      validationStatus: plain.validationStatus,
    });
  } catch (error) {
    logger.error('判断订单自动刷新资格失败', { error: error.message });
    return false;
  }
}

/**
 * 扫描并刷新符合条件的订单
 * @returns {Promise<Object>} 扫描结果
 */
async function scanAndRefreshEligibleOrders() {
  if (schedulerState.isPaused) {
    return {
      scanned: 0,
      eligible: 0,
      refreshed: 0,
      failed: 0,
      skipped: true,
      reason: schedulerState.pauseReason,
    };
  }

  if (schedulerState.isScanning) {
    return {
      scanned: 0,
      eligible: 0,
      refreshed: 0,
      failed: 0,
      skipped: true,
      reason: 'previous_scan_running',
    };
  }

  schedulerState.isScanning = true;
  schedulerState.lastScanAt = new Date();

  try {
    const orders = await Order.findAll({
      where: {
        [Op.or]: [
          { orderUrl: { [Op.ne]: null } },
          { orderNumber: { [Op.ne]: null } },
        ],
      },
      attributes: [
        'id',
        'orderNumber',
        'orderUrl',
        'status',
        'paymentStatus',
        'pickupStatus',
        'validationStatus',
        'autoRefreshEnabled',
      ],
      order: [['lastCrawledAt', 'ASC'], ['id', 'ASC']],
    });

    const eligibleOrders = orders.filter(isOrderEligibleForAutoRefresh);
    let refreshed = 0;
    let failed = 0;

    await createCrawlLog({
      source: 'scheduled',
      severity: 'info',
      eventType: 'scheduler',
      event: 'auto_refresh_scan',
      success: true,
      context: {
        scanned: orders.length,
        eligible: eligibleOrders.length,
      },
      result: 'scanned',
    });

    for (const order of eligibleOrders) {
      if (schedulerState.isPaused) {
        break;
      }

      try {
        await crawlAndUpdateOrder(order.id, { source: 'scheduled' });
        refreshed++;
      } catch (error) {
        failed++;
        logger.warn('自动刷新订单失败', {
          orderId: order.id,
          orderNumber: order.orderNumber,
          error: error.message,
        });
      }

      await sleep(getRandomDelay());
    }

    return {
      scanned: orders.length,
      eligible: eligibleOrders.length,
      refreshed,
      failed,
      skipped: false,
    };
  } catch (error) {
    logger.error('自动刷新扫描失败', {
      error: error.message,
      stack: error.stack,
    });

    await createCrawlLog({
      source: 'scheduled',
      severity: 'error',
      eventType: 'scheduler',
      event: 'auto_refresh_scan_failed',
      success: false,
      errorMessage: error.message,
      errorStack: error.stack,
      result: 'failed',
    });

    await sendTelegramAlert('自动刷新扫描失败', {
      error: error.message,
    });

    throw error;
  } finally {
    schedulerState.isScanning = false;
    schedulerState.nextScanAt = new Date(Date.now() + config.crawler.autoRefreshIntervalMs);
  }
}

/**
 * 启动自动刷新调度器
 * @returns {Promise<Object>} 当前状态
 */
async function startAutoRefreshScheduler() {
  try {
    if (!config.crawler.autoRefreshEnabled) {
      logger.info('自动刷新调度器未启用', {
        env: config.app.env,
      });
      return getAutoRefreshStatus();
    }

    if (schedulerState.isRunning) {
      return getAutoRefreshStatus();
    }

    if (config.proxy.enabled && !proxyManager.getStatus().isInitialized) {
      await proxyManager.initialize();
    }

    schedulerState.isRunning = true;
    schedulerState.nextScanAt = new Date(Date.now() + config.crawler.autoRefreshIntervalMs);
    schedulerState.timer = setInterval(() => {
      scanAndRefreshEligibleOrders().catch((error) => {
        logger.error('自动刷新调度任务执行失败', { error: error.message });
      });
    }, config.crawler.autoRefreshIntervalMs);
    schedulerState.timer.unref?.();

    await createCrawlLog({
      source: 'system',
      severity: 'info',
      eventType: 'scheduler',
      event: 'auto_refresh_started',
      success: true,
      context: {
        intervalMs: config.crawler.autoRefreshIntervalMs,
      },
      result: 'started',
    });

    logger.info('自动刷新调度器已启动', {
      intervalMs: config.crawler.autoRefreshIntervalMs,
    });

    return getAutoRefreshStatus();
  } catch (error) {
    logger.error('启动自动刷新调度器失败', {
      error: error.message,
      stack: error.stack,
    });

    await createCrawlLog({
      source: 'system',
      severity: 'error',
      eventType: 'scheduler',
      event: 'auto_refresh_start_failed',
      success: false,
      errorMessage: error.message,
      errorStack: error.stack,
      result: 'failed',
    });

    await sendTelegramAlert('自动刷新调度器启动失败', {
      error: error.message,
    });
    return getAutoRefreshStatus();
  }
}

/**
 * 停止自动刷新调度器
 * @returns {void}
 */
function stopAutoRefreshScheduler() {
  try {
    if (schedulerState.timer) {
      clearInterval(schedulerState.timer);
      schedulerState.timer = null;
    }
    schedulerState.isRunning = false;
    schedulerState.nextScanAt = null;
    logger.info('自动刷新调度器已停止');
  } catch (error) {
    logger.error('停止自动刷新调度器失败', { error: error.message });
  }
}

module.exports = {
  fetchOrderPage,
  extractOrderJson,
  parseOrderData,
  summarizeOrderUrl,
  extractOfficialAmount,
  fetchWithRetry,
  crawlAndUpdateOrder,
  crawlMultipleOrders,
  validateProducts,
  getAutoRefreshStopReason,
  isOrderEligibleForAutoRefresh,
  scanAndRefreshEligibleOrders,
  startAutoRefreshScheduler,
  stopAutoRefreshScheduler,
  getAutoRefreshStatus,
  resumeAutoRefresh,
  pauseAutoRefresh,
  createCrawlLog,
  sleep,
  getRandomDelay,
};
