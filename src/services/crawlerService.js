/**
 * 订单爬虫服务模块
 * 功能：爬取 Apple 官网订单详情，提取订单状态、商品信息、取机门店等数据
 *
 * 代理使用策略：
 * - 所有爬虫功能必须使用代理（防止 IP 被 Apple 风控）
 * - 隧道代理在单次抓取及重定向期间固定出口，重试通过新 sid 换出口
 * - 私密代理兼容模式保留失败计数和 HTTP 541 废弃 IP 规则
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
const { Order, CrawlLog, PaymentTask, sequelize } = require('../models');
const {
  APPLE_CURRENT_STATUS_MAP,
  TERMINAL_STATUSES,
  summarizeLifecycle,
  paymentForStatus,
  pickupForStatus,
  safeText,
  parseOfficialFields,
  mergeOfficialOrder,
  getOfficialDeadline,
} = require('./crawler/officialOrderData');
const { config } = require('../utils/config');
const { sendTelegramAlert } = require('../utils/telegramNotifier');
const crawlerRateLimiter = require('./crawler/crawlerRateLimiter');
const refreshJobRepository = require('./crawler/refreshJobRepository');
const { classifyRefreshError, sanitizeRefreshError } = require('./crawler/refreshErrors');
const { isAutoRefreshEligible } = require('./crawler/refreshPolicy');
const { PAYMENT_ASSIGNMENT_LOCK_ID } = require('./permissionService');

const MAX_CRAWL_ATTEMPTS = 3;
const AUTO_STOP_STATUSES = TERMINAL_STATUSES;
const ORDER_ITEM_KEY_PATTERN = /^orderItem-\d+(?:of\d+)?(?:-\d+)*$/;
const HIDDEN_ORDER_TEXT_SELECTORS = [
  'script',
  'style',
  'template',
  'noscript',
  'footer',
  '[hidden]',
  '[aria-hidden="true"]',
  '[style*="display:none"]',
  '[style*="display: none"]',
].join(', ');
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
    const orderNumber = pathParts.find(part => /^W\d{10}$/.test(part)) || null;
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
 * 验证待访问的 Apple 订单 URL 与本地订单身份一致。
 * @param {string} orderUrl - 订单 URL
 * @param {string} expectedOrderNumber - 期望订单号
 * @returns {URL} 验证后的 URL
 * @throws {Error} URL 来源或身份不匹配时抛出异常
 */
function validateOrderUrl(orderUrl, expectedOrderNumber) {
  try {
    const parsedUrl = new URL(orderUrl);
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const isExpectedPath =
      pathParts.length === 5 &&
      pathParts[0] === 'xc' &&
      pathParts[1] === 'cn' &&
      pathParts[2] === 'vieworder' &&
      /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(pathParts[4]);
    // 链接末段是订单联系邮箱，不是下单账户 Apple ID。
    const isExpectedIdentity =
      /^W\d{10}$/.test(expectedOrderNumber) && pathParts[3] === expectedOrderNumber;

    if (
      parsedUrl.protocol !== 'https:' ||
      parsedUrl.hostname !== 'www.apple.com.cn' ||
      parsedUrl.port ||
      parsedUrl.username ||
      parsedUrl.password ||
      !isExpectedPath ||
      !isExpectedIdentity
    ) {
      const error = new Error('订单 URL 来源或身份与本地订单不一致');
      error.eventType = 'order_identity';
      throw error;
    }

    return parsedUrl;
  } catch (error) {
    if (error.eventType === 'order_identity') {
      throw error;
    }
    const invalidUrlError = new Error('订单 URL 格式无效');
    invalidUrlError.eventType = 'order_identity';
    throw invalidUrlError;
  }
}

/**
 * 校验官网返回的订单号。
 * @param {Object} crawledData - 官网解析结果
 * @param {string} expectedOrderNumber - 本地订单号
 * @returns {void}
 * @throws {Error} 身份缺失或不匹配时抛出异常
 */
function validateCrawledOrderIdentity(crawledData, expectedOrderNumber) {
  if (!crawledData.orderNumber || crawledData.orderNumber !== expectedOrderNumber) {
    const error = new Error('官网返回的订单身份与本地订单不一致');
    error.eventType = 'order_identity';
    error.skipFailureIncrement = true;
    throw error;
  }
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 生成旧批量入口使用的随机延迟时间（5-10秒）
 * @returns {number} 延迟毫秒数
 */
function getRandomDelay() {
  const minDelay = config.crawler.requestDelay?.min || 5000;
  const maxDelay = config.crawler.requestDelay?.max || 10000;
  return Math.floor(Math.random() * (maxDelay - minDelay)) + minDelay;
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
 * 获取去除脚本、样式、隐藏节点和页脚后的订单可见文本。
 * @param {Function} $ - Cheerio 实例
 * @returns {string} 清理后的页面文本
 */
function extractVisibleOrderText($) {
  const body = $('body').clone();
  body.find(HIDDEN_ORDER_TEXT_SELECTORS).remove();
  return body.text().replace(/\s+/g, ' ').trim();
}

/**
 * 按 Apple JSON 提供的顺序取得订单项键。
 * @param {Object} orderItems - Apple 订单项容器
 * @returns {string[]} 有效订单项键
 */
function getOrderedOrderItemKeys(orderItems) {
  const declaredKeys = Array.isArray(orderItems?.c) ? orderItems.c : [];
  const fallbackKeys = Object.keys(orderItems || {}).filter(key =>
    ORDER_ITEM_KEY_PATTERN.test(key)
  );
  return [...new Set([...declaredKeys, ...fallbackKeys])].filter(
    key => ORDER_ITEM_KEY_PATTERN.test(key) && orderItems[key]
  );
}

/**
 * 合并官网同一商品行的完整逐台展示副本，保留不确定或状态不同的节点。
 * @param {string[]} keys - 原始订单项键
 * @param {Object[]} items - 原始订单项
 * @param {Object[]} products - 按原顺序解析的完整商品
 * @returns {Object[]} 不重复的商品行
 */
function collapseUnitProductCopies(keys, items, products) {
  if (products.length !== items.length) return products;
  const groups = new Map();
  keys.forEach((key, index) => {
    const match = /^orderItem-(\d+)of(\d+)-(\d+(?:-\d+)*)$/.exec(key);
    if (!match) return;
    const [, ordinalText, totalText, suffix] = match;
    const ordinal = Number(ordinalText);
    const total = Number(totalText);
    const details = items[index].orderItemDetails?.d || {};
    const groupKey = `${suffix}:${total}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ index, ordinal, total, details });
  });
  const omitted = new Set();
  for (const entries of groups.values()) {
    const total = entries[0].total;
    if (!Number.isSafeInteger(total) || total < 2 || entries.length !== total) continue;
    const ordinals = new Set(entries.map(entry => entry.ordinal));
    const fingerprint = JSON.stringify(products[entries[0].index]);
    const verified =
      ordinals.size === total &&
      entries.every(
        ({ index, ordinal, details }) =>
          ordinal >= 1 &&
          ordinal <= total &&
          Number(details.eyeBrowNumber) === ordinal &&
          Number(details.eyeBrowQuantity) === total &&
          products[index].quantity === total &&
          JSON.stringify(products[index]) === fingerprint
      );
    if (verified) entries.slice(1).forEach(entry => omitted.add(entry.index));
  }
  return products.filter((product, index) => !omitted.has(index));
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

    const hasTotalLabel = /订单总计|总计|合计/.test(normalizedText);
    return {
      amount: null,
      currency: null,
      parseError: hasTotalLabel ? '页面包含订单总计，但金额格式无法识别' : null,
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
 * @param {string|null} rawCurrentStatus - Apple 原始 currentStatus
 * @returns {string|null} 标准支付状态
 */
function inferPaymentStatus(bodyText, orderStatus = null, rawCurrentStatus = null) {
  const text = String(bodyText || '');
  const mappedPayment = paymentForStatus(APPLE_CURRENT_STATUS_MAP[rawCurrentStatus] || orderStatus);
  if (mappedPayment) return mappedPayment;
  if (/已收到付款|已付款|支付成功|已支付/.test(text)) {
    return 'paid';
  }
  if (/待付款|等待付款|未付款/.test(text)) {
    return 'unpaid';
  }
  if (['ready_for_pickup', 'completed', 'delivered'].includes(orderStatus)) {
    return 'paid';
  }
  if (/退款|已退款/.test(text)) {
    return 'refunded';
  }
  return null;
}

/**
 * 比对邮件商品和官网商品
 * @param {Array<Object>} emailProducts - 邮件导入商品
 * @param {Array<Object>} officialProducts - 官网商品
 * @param {Object} options - 校验上下文
 * @returns {Object} 校验结果
 */
function validateProducts(emailProducts = [], officialProducts = [], _options = {}) {
  try {
    if (!Array.isArray(officialProducts) || officialProducts.length === 0) {
      return {
        status: VALIDATION_STATUS.UNAVAILABLE,
        issues: [
          {
            type: 'official_products_missing',
            message: '官网商品信息为空，无法完成交叉验证',
          },
        ],
        comparisons: [],
      };
    }

    const matchedOfficialIndexes = new Set();
    const issues = [];
    const comparisons = emailProducts.map(emailProduct => {
      const emailModel = normalizeProductText(emailProduct.model || emailProduct.modelId);
      const emailName = normalizeProductText(emailProduct.name);

      const officialIndex = officialProducts.findIndex((officialProduct, index) => {
        if (matchedOfficialIndexes.has(index)) {
          return false;
        }

        const officialModel = normalizeProductText(
          officialProduct.model || officialProduct.modelId
        );
        const officialName = normalizeProductText(officialProduct.name);

        if (emailModel && officialModel && emailModel === officialModel) {
          return true;
        }

        return (
          emailName &&
          officialName &&
          (officialName.includes(emailName) || emailName.includes(officialName))
        );
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
  if (orderLike.officialAllItemsTerminal) return 'status:all_items_terminal';
  if (['paid', 'refunded'].includes(orderLike.paymentStatus))
    return `payment_status:${orderLike.paymentStatus}`;
  if ((orderLike.validationIssues || []).some(issue => issue.type === 'order_identity'))
    return 'order_identity';
  return null;
}

/**
 * 记录结构化爬虫/系统日志
 * @param {Object} logData - 日志数据
 * @returns {Promise<Object|null>} 日志记录
 */
async function createCrawlLog(logData) {
  try {
    const upstreamHttpStatus = Number(logData.httpStatus);
    const validHttpStatus =
      Number.isInteger(upstreamHttpStatus) &&
      upstreamHttpStatus >= 100 &&
      upstreamHttpStatus <= 599;
    const nonstandardStatus =
      Number.isInteger(upstreamHttpStatus) && upstreamHttpStatus > 599 && upstreamHttpStatus <= 999;
    return await CrawlLog.create({
      orderId: logData.orderId || null,
      source: logData.source || 'system',
      severity: logData.severity || 'info',
      eventType: logData.eventType || 'crawler',
      event: logData.event || null,
      proxyIp: logData.proxyIp || null,
      success: Boolean(logData.success),
      responseTime: logData.responseTime || null,
      httpStatus: validHttpStatus ? upstreamHttpStatus : null,
      errorMessage: logData.errorMessage || null,
      errorStack: logData.errorStack || null,
      crawledData: logData.crawledData || null,
      context: nonstandardStatus
        ? { ...logData.context, upstreamHttpStatus }
        : logData.context || null,
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

    try {
      await refreshJobRepository.pause(reason);
    } catch (persistError) {
      logger.warn('持久化自动刷新暂停状态失败', { error: persistError.message });
    }

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
      Connection: proxy?.disableKeepAlive ? 'close' : 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Accept-Encoding': 'gzip',
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
    const primary = $('script#init_data');
    if (primary.length) {
      try {
        return JSON.parse(primary.first().html());
      } catch (_error) {
        logger.warn('官网 init_data JSON 无效');
        return null;
      }
    }

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
            reason: 'invalid_json',
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
 * 解析官网订单创建时间。只有包含时分的值才可用于 30 分钟付款窗口。
 * @param {unknown} value - Apple orderPlacedDate 原始值
 * @returns {Date|null} 精确官网时间或 null
 */
function parseOfficialOrderCreatedAt(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;

  const chineseMatch = text.match(
    /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(上午|下午)?\s*(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?/
  );
  if (chineseMatch) {
    let hour = Number(chineseMatch[5]);
    if (chineseMatch[4] === '下午' && hour < 12) hour += 12;
    if (chineseMatch[4] === '上午' && hour === 12) hour = 0;
    if (hour > 23) return null;
    const isoTime = [
      chineseMatch[1],
      chineseMatch[2].padStart(2, '0'),
      chineseMatch[3].padStart(2, '0'),
    ].join('-');
    const parsed = new Date(
      `${isoTime}T${String(hour).padStart(2, '0')}:${chineseMatch[6]}:${chineseMatch[7] || '00'}+08:00`
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const hasExplicitTime = /(?:T|\s)\d{1,2}:\d{2}/.test(text);
  if (!hasExplicitTime) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}+08:00`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
    const bodyText = extractVisibleOrderText($);

    // 1. 提取订单基本信息
    const orderHeader = orderJson.orderDetail?.orderHeader?.d || {};
    const orderNumber = orderHeader.orderNumber || null;
    const orderPlacedDate = orderHeader.orderPlacedDate || null;
    const officialOrderCreatedAt = parseOfficialOrderCreatedAt(orderPlacedDate);

    // 日期格式转换: "2025年11月8日" → "2025-11-08"
    let orderDate = null;
    if (orderPlacedDate) {
      const dateMatch = orderPlacedDate.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (dateMatch) {
        orderDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
      }
    }

    const orderItems = orderJson.orderDetail?.orderItems || {};
    const keys = getOrderedOrderItemKeys(orderItems);
    const items = keys.map(key => orderItems[key]);
    const lifecycle = summarizeLifecycle(items);
    if (lifecycle.officialStatusNeedsReview)
      logger.warn('官网订单阶段需要人工核对', { itemCount: items.length });
    let orderStatus = lifecycle.orderStatus;
    const statusKeywords = {
      已取货: 'picked_up',
      取货已取消: 'pickup_cancelled',
      已取消: 'cancelled',
      已送达: 'delivered',
      准备就绪: 'ready_for_pickup',
      可取货: 'ready_for_pickup',
      已收到付款: 'payment_received',
      等待付款: 'payment_due',
      处理中: 'processing',
      已发货: 'shipped',
    };
    // 明确出现未知原始枚举时不得被正文或 possibleStatuses 中的旧轨迹覆盖。
    if (!items.some(item => item.orderItemStatusTracker?.d?.currentStatus)) {
      for (const [keyword, value] of Object.entries(statusKeywords)) {
        if (bodyText.includes(keyword)) {
          orderStatus = value;
          break;
        }
      }
      lifecycle.officialStatusNeedsReview = orderStatus === 'unknown';
      lifecycle.paymentStatus = inferPaymentStatus(bodyText, orderStatus);
      lifecycle.pickupStatus = pickupForStatus(orderStatus);
    }
    const rawProducts = items
      .filter(item => item.orderItemDetails?.d)
      .map(item => {
        const details = item.orderItemDetails.d;
        const tracker = item.orderItemStatusTracker?.d || {};
        const hasNumericQuantity =
          typeof details.quantity === 'number' ||
          (typeof details.quantity === 'string' && /^\d+$/.test(details.quantity));
        const quantity =
          hasNumericQuantity &&
          Number.isSafeInteger(Number(details.quantity)) &&
          Number(details.quantity) >= 0
            ? Number(details.quantity)
            : null;
        return {
          name: safeText(details.productName || details.itemShortName) || '',
          model:
            safeText(
              details.partNumber || details.sku || details.productId || details.modelNumber
            ) || '',
          quantity,
          status: safeText(tracker.currentStatus, 100) || 'unknown',
          statusDescription: safeText(tracker.statusDescription),
          deliveryType: safeText(item.d?.deliveryType, 50),
          pickupType: safeText(
            details.pickupType || tracker.pickupType || item.shippingInfo?.d?.pickupType,
            50
          ),
          fulfillmentMessage: safeText(details.deliveryDate, 1000),
        };
      });
    const productsComplete =
      rawProducts.length === items.length &&
      rawProducts.length > 0 &&
      rawProducts.every(product => product.name && product.quantity !== null);
    const products = collapseUnitProductCopies(keys, items, rawProducts);

    // 4. 提取取机门店信息
    let pickupStore = null;
    let storeDirectionsUrl = null;

    // 从第一个商品的配送信息中提取门店
    const firstItemKey = getOrderedOrderItemKeys(orderItems)[0];
    if (firstItemKey) {
      const firstItem = orderItems[firstItemKey];
      const storeInfo = firstItem?.shippingInfo?.['shipping-address']?.address?.d;

      pickupStore = safeText(storeInfo?.companyName) || null;
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

    const officialFields = parseOfficialFields(orderJson.orderDetail || {}, items);
    if (officialFields.officialFieldDiagnostics.amount === 'missing') {
      const legacyAmount = extractOfficialAmount(bodyText);
      if (legacyAmount.amount !== null || legacyAmount.parseError) {
        officialFields.officialOrderAmount = legacyAmount.amount;
        officialFields.officialOrderAmountCurrency = legacyAmount.currency;
        officialFields.officialOrderAmountParseError = legacyAmount.parseError;
        officialFields.officialFieldDiagnostics.amount = legacyAmount.parseError
          ? 'invalid'
          : 'value';
      }
    }

    return {
      orderNumber,
      orderDate,
      officialOrderCreatedAt,
      ...lifecycle,
      ...officialFields,
      orderStatus,
      productsComplete,
      products,
      pickupStore,
      storeDirectionsUrl,
    };
  } catch (error) {
    logger.error('解析订单数据失败', {
      error: '官网业务字段结构无法解析',
    });
    const parseError = new Error('官网业务字段结构无法解析');
    parseError.eventType = 'parse';
    throw parseError;
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
  let windControlAttemptCount = 0;
  const requestedAttempts = Number.parseInt(maxRetries, 10);
  const attemptLimit = Number.isFinite(requestedAttempts)
    ? Math.min(Math.max(requestedAttempts, 1), MAX_CRAWL_ATTEMPTS)
    : MAX_CRAWL_ATTEMPTS;

  if (!proxyManager.getStatus().isInitialized) {
    await proxyManager.initialize();
  }

  for (let attempt = 1; attempt <= attemptLimit; attempt++) {
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
        maxRetries: attemptLimit,
        proxy: `${currentProxy.host}:${currentProxy.port}`,
      });

      // 发送请求
      await crawlerRateLimiter.acquire();
      const html = await fetchOrderPage(orderUrl, currentProxy);

      // 提取 JSON 数据
      const orderJson = extractOrderJson(html);

      if (!orderJson) {
        const parseError = new Error('无法提取订单 JSON 数据');
        parseError.eventType = 'parse';
        throw parseError;
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
      error.httpStatus = error.httpStatus || error.response?.status;
      error.proxyProvider = currentProxy?.provider || proxyManager.getStatus().activeProvider;

      if ([407, 441, 517].includes(error.httpStatus)) {
        error.eventType = 'proxy';
      }
      error.refreshErrorCode = classifyRefreshError(error);

      logger.warn('订单爬取失败', {
        attempt,
        maxRetries: attemptLimit,
        error: error.message,
        statusCode: error.response?.status,
        proxy: currentProxy ? `${currentProxy.host}:${currentProxy.port}` : 'none',
      });

      const isKdlProvider = String(currentProxy?.provider || '').startsWith('kdl_');
      if (
        currentProxy &&
        error.httpStatus !== 407 &&
        !(error.httpStatus === 441 && isKdlProvider)
      ) {
        // HTTP 541: 私密代理废弃 IP；隧道 Provider 在下次重试生成新 sid
        if (error.response?.status === 541) {
          logger.warn('检测到 Apple 风控（HTTP 541），下次重试切换代理出口');
          proxyManager.markProxyAsBad(currentProxy);
          windControlAttemptCount++;
          error.isWindControl = true;
          error.httpStatus = 541;
          error.proxyIp = `${currentProxy.host}:${currentProxy.port}`;
          error.eventType = 'wind_control';
          // 不在这里刷新固定入口；重试时从 Provider 获取下一代理会话
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

      if (error.httpStatus === 407) {
        await pauseAutoRefreshForProxyFailure('代理鉴权失败（HTTP 407）', {
          urlSummary: summarizeOrderUrl(orderUrl),
          proxy: `${currentProxy.host}:${currentProxy.port}`,
        });
        break;
      }

      // 如果还有重试机会，延时后重试
      if (attempt < attemptLimit) {
        const retryMin = config.crawler.retryDelayMinMs || 1000;
        const retryMax = config.crawler.retryDelayMaxMs || 5000;
        const delay = Math.min(retryMax, retryMin * attempt) + Math.floor(Math.random() * 250);
        logger.info('等待后重试', {
          delaySeconds: (delay / 1000).toFixed(1),
          nextAttempt: attempt + 1,
        });
        await sleep(delay);
      }
    }
  }

  if (windControlAttemptCount === attemptLimit) {
    schedulerState.consecutiveWindControlCount++;
    if (schedulerState.consecutiveWindControlCount >= config.crawler.windControlPauseThreshold) {
      await pauseAutoRefresh('连续订单耗尽重试并触发 Apple 风控', {
        urlSummary: summarizeOrderUrl(orderUrl),
        proxyIp: lastError.proxyIp,
        consecutiveWindControlCount: schedulerState.consecutiveWindControlCount,
        threshold: config.crawler.windControlPauseThreshold,
      });
    }
  }

  // 所有重试都失败
  const retryError = new Error(`爬取订单失败，已重试 ${attemptLimit} 次: ${lastError.message}`);
  retryError.isWindControl = Boolean(lastError.isWindControl);
  retryError.httpStatus = lastError.httpStatus || lastError.response?.status;
  retryError.proxyIp =
    lastError.proxyIp || (currentProxy ? `${currentProxy.host}:${currentProxy.port}` : null);
  retryError.eventType = lastError.eventType || 'crawler';
  retryError.proxyProvider = lastError.proxyProvider || null;
  retryError.refreshErrorCode = lastError.refreshErrorCode || classifyRefreshError(lastError);
  throw retryError;
}

/**
 * 爬取订单并更新数据库
 * @param {number} orderId - 订单 ID
 * @returns {Promise<Object>} 更新结果
 * @throws {Error} 当爬取或更新失败时抛出异常
 */
async function crawlAndUpdateOrder(orderId, options = {}) {
  let transaction = null;
  let order = null;
  const startTime = Date.now();
  const source = options.source || (options.manual ? 'manual' : 'auto');

  try {
    // 1. 查询订单信息
    order = await Order.findByPk(orderId, {
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

    if (!order.orderUrl && !order.appleAccount?.appleId && !order.appleId) {
      throw new Error('Apple ID 缺失，无法构建爬取 URL');
    }

    // 2. 构建订单详情页 URL
    const appleId = order.appleAccount?.appleId || order.appleId;
    const orderUrl =
      order.orderUrl ||
      `https://www.apple.com.cn/xc/cn/vieworder/${order.orderNumber}/${encodeURIComponent(appleId)}`;
    validateOrderUrl(orderUrl, order.orderNumber);
    if (
      source === 'page_open' ||
      (!options.manual && !isAutoRefreshEligible({ ...order.toJSON(), orderUrl }))
    ) {
      return { success: true, skipped: true, reason: 'automatic_refresh_not_eligible' };
    }
    const expectedOrderNumber = order.orderNumber;
    const initialUpdatedAt = order.updatedAt ? new Date(order.updatedAt).getTime() : null;

    logger.info('开始爬取订单数据', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      urlSummary: summarizeOrderUrl(orderUrl),
      source,
    });

    // 3. 爬取订单数据（带重试）
    const crawlResult = await fetchWithRetry(orderUrl, config.crawler.maxRetry);
    const { data: crawledData, proxy } = crawlResult;
    validateCrawledOrderIdentity(crawledData, expectedOrderNumber);
    // 网络请求结束后才开启短事务，并在写入前锁定目标行。
    transaction = await sequelize.transaction();
    await sequelize.query('SELECT pg_advisory_xact_lock(:lockId)', {
      replacements: { lockId: PAYMENT_ASSIGNMENT_LOCK_ID },
      transaction,
    });
    const lockedOrder = await Order.findByPk(orderId, {
      transaction,
      lock: transaction.LOCK?.UPDATE || true,
    });
    if (!lockedOrder) {
      throw new Error(`订单不存在: ID ${orderId}`);
    }
    const lockedUpdatedAt = lockedOrder.updatedAt
      ? new Date(lockedOrder.updatedAt).getTime()
      : null;
    if (initialUpdatedAt !== null && lockedUpdatedAt !== initialUpdatedAt) {
      const concurrentUpdateError = new Error('订单在爬取期间已被其他任务更新，本次结果已放弃');
      concurrentUpdateError.eventType = 'concurrency';
      concurrentUpdateError.skipFailureIncrement = true;
      throw concurrentUpdateError;
    }
    if (lockedOrder.orderNumber !== expectedOrderNumber) {
      const identityChangedError = new Error('订单身份在爬取期间已变更，本次结果已放弃');
      identityChangedError.eventType = 'concurrency';
      identityChangedError.skipFailureIncrement = true;
      throw identityChangedError;
    }
    order = lockedOrder;

    const updateData = mergeOfficialOrder(order, crawledData);
    const autoRefreshStopReason = getAutoRefreshStopReason({ ...order.toJSON(), ...updateData });
    const validationResult = {
      status: updateData.validationStatus,
      issues: updateData.validationIssues,
      comparisons: [],
    };
    // 保留人工关闭；仅由此前校验差异引起的暂停可在成功身份校验后恢复。
    const manuallyDisabled = order.autoRefreshEnabled === false && !order.autoRefreshStopReason;
    Object.assign(updateData, {
      autoRefreshEnabled: !autoRefreshStopReason && !manuallyDisabled,
      autoRefreshStopReason,
      autoRefreshStoppedAt: autoRefreshStopReason ? new Date() : null,
      lastCrawledAt: new Date(),
      crawlFailCount: 0,
    });
    const previousDeadline = getOfficialDeadline(order);
    const nextDeadline = getOfficialDeadline({ ...order.toJSON(), ...updateData });
    await order.update(updateData, { transaction });
    if (nextDeadline && nextDeadline.getTime() !== previousDeadline?.getTime()) {
      await PaymentTask.update(
        {
          deadlineAt: nextDeadline,
          deadlineSource: 'official',
          eligibilityVerifiedAt: null,
          eligibilityValidUntil: null,
          eligibilityVerifiedBy: null,
          paymentLinkSource: order.orderUrl ? 'order_url' : null,
          version: sequelize.literal('version + 1'),
        },
        { where: { orderId: order.id }, transaction }
      );
    }

    // 5. 记录爬取日志
    const responseTime = Date.now() - startTime;
    await CrawlLog.create(
      {
        orderId: order.id,
        source,
        severity: validationResult.status === VALIDATION_STATUS.ABNORMAL ? 'warn' : 'info',
        eventType:
          validationResult.status === VALIDATION_STATUS.ABNORMAL ? 'product_validation' : 'crawler',
        event:
          validationResult.status === VALIDATION_STATUS.ABNORMAL
            ? 'order_marked_abnormal'
            : 'order_sync_success',
        proxyIp: proxy,
        success: true,
        responseTime,
        errorMessage: null,
        crawledData: null,
        context: {
          orderNumber: order.orderNumber,
          officialProductCount: crawledData.products.length,
          validationStatus: validationResult.status,
          issueTypes: validationResult.issues.map(issue => issue.type),
          amountParseError: crawledData.officialOrderAmountParseError,
          autoRefreshStopReason,
        },
        result: validationResult.status,
      },
      { transaction }
    );

    await transaction.commit();
    transaction = null;

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
      officialOrderAmount: order.officialOrderAmount,
      officialOrderAmountCurrency: order.officialOrderAmountCurrency,
      validationStatus: validationResult.status,
      validationIssues: validationResult.issues,
      productComparisons: validationResult.comparisons,
      autoRefreshStopReason,
      responseTime,
    };
  } catch (error) {
    if (transaction && !transaction.finished) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        logger.error('回滚订单爬取事务失败', {
          orderId,
          error: rollbackError.message,
        });
      }
    }

    if (error.eventType === 'order_identity' && order) {
      try {
        await sequelize.transaction(async identityTransaction => {
          await sequelize.query('SELECT pg_advisory_xact_lock(:lockId)', {
            replacements: { lockId: PAYMENT_ASSIGNMENT_LOCK_ID },
            transaction: identityTransaction,
          });
          await Order.update(
            {
              validationStatus: 'abnormal',
              validationIssues: [
                {
                  type: 'order_identity',
                  field: 'orderNumber',
                  message: '订单链接或官网返回身份不一致，已拒绝覆盖，请人工核对',
                },
              ],
              anomalyDetectedAt: new Date(),
              autoRefreshEnabled: false,
              autoRefreshStopReason: 'order_identity',
              autoRefreshStoppedAt: new Date(),
            },
            { where: { id: orderId, updatedAt: order.updatedAt }, transaction: identityTransaction }
          );
        });
      } catch (_error) {
        logger.error('保存身份异常失败', { orderId });
      }
    }
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
      errorMessage: sanitizeRefreshError(error),
      errorStack: null,
      isWindControl: Boolean(error.isWindControl),
      context: {
        manual: Boolean(options.manual),
      },
      result: 'failed',
    });

    if (!error.skipFailureIncrement) {
      try {
        await Order.increment('crawlFailCount', { where: { id: orderId } });
      } catch (incrementError) {
        logger.error('更新爬取失败次数失败', {
          orderId,
          error: incrementError.message,
        });
      }
    }

    logger.error('订单爬取更新失败', {
      orderId,
      error: sanitizeRefreshError(error),
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
    return isAutoRefreshEligible(plain);
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
        [Op.or]: [{ orderUrl: { [Op.ne]: null } }, { orderNumber: { [Op.ne]: null } }],
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
      order: [
        ['lastCrawledAt', 'ASC'],
        ['id', 'ASC'],
      ],
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
      scanAndRefreshEligibleOrders().catch(error => {
        logger.error('自动刷新调度任务执行失败', { error: error.message });
      });
    }, config.crawler.autoRefreshIntervalMs);
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
  parseOfficialOrderCreatedAt,
  summarizeOrderUrl,
  validateOrderUrl,
  validateCrawledOrderIdentity,
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
