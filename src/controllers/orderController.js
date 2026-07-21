/* eslint-disable camelcase */
/**
 * 订单控制器
 * @module controllers/orderController
 * @description 订单列表 / 详情 / 手动刷新 / 批量刷新四个端点
 * @see docs/05-API接口设计方案.md 3.3
 */

const { Op } = require('sequelize');
const { Order, AppleId, Recipient, EmailLog } = require('../models');
const crawlerService = require('../services/crawlerService');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const {
  paginatedResponse,
  parsePositiveInt,
} = require('../utils/apiResponse');

const ORDER_STATUSES = [
  'pending',
  'processing',
  'shipped',
  'ready_for_pickup',
  'completed',
  'delivered',
  'cancelled',
  'pickup_cancelled',
  'unknown',
];

/**
 * 把 Order（含 appleAccount/recipient）序列化为对外列表项
 * @param {Order} order - Sequelize Order 实例
 * @returns {Object} 列表项
 */
function serializeOrderListItem(order) {
  const plain = order.toJSON();
  return {
    id: plain.id,
    order_number: plain.orderNumber,
    apple_id: plain.appleAccount?.appleId || null,
    recipient_name: plain.recipient
      ? `${plain.recipient.lastName}${plain.recipient.firstName}`
      : null,
    products: plain.products,
    status: plain.status,
    payment_status: plain.paymentStatus,
    pickup_status: plain.pickupStatus,
    official_order_amount: plain.officialOrderAmount,
    official_order_amount_currency: plain.officialOrderAmountCurrency,
    official_order_amount_parse_error: plain.officialOrderAmountParseError,
    official_products: plain.officialProducts,
    validation_status: plain.validationStatus,
    validation_issues: plain.validationIssues,
    anomaly_detected_at: plain.anomalyDetectedAt,
    auto_refresh_enabled: plain.autoRefreshEnabled,
    auto_refresh_stop_reason: plain.autoRefreshStopReason,
    auto_refresh_stopped_at: plain.autoRefreshStoppedAt,
    pickup_store: plain.pickupStore,
    recipient_id_card: plain.recipientIdCard,
    recipient_email: plain.recipientEmail,
    recipient_phone: plain.recipientPhone,
    recipient_address: plain.recipientAddress,
    apple_password: plain.applePassword,
    order_url: plain.orderUrl,
    pickup_store_code: plain.pickupStoreCode,
    pickup_code: plain.pickupCode,
    pickup_time_slot: plain.pickupTimeSlot,
    actual_pickup_date: plain.actualPickupDate,
    payment_method: plain.paymentMethod,
    payer_name: plain.payerName,
    payment_screenshot: plain.paymentScreenshot,
    order_date: plain.orderDate,
    last_crawled_at: plain.lastCrawledAt,
    crawl_fail_count: plain.crawlFailCount,
    tag: plain.tag,
    created_at: plain.createdAt,
    updated_at: plain.updatedAt,
  };
}

/**
 * 完整订单详情序列化
 * @param {Order} order - Sequelize Order 实例
 * @returns {Object} 详情对象
 */
function serializeOrderDetail(order) {
  const plain = order.toJSON();
  return {
    id: plain.id,
    order_number: plain.orderNumber,
    apple_id: plain.appleAccount
      ? {
        id: plain.appleAccount.id,
        apple_id: plain.appleAccount.appleId,
        nickname: plain.appleAccount.nickname,
      }
      : null,
    recipient: plain.recipient
      ? {
        id: plain.recipient.id,
        name: `${plain.recipient.lastName}${plain.recipient.firstName}`,
        id_card_last4: plain.recipient.idCardLast4,
        tag: plain.recipient.tag,
        phone: plain.recipient.phone,
      }
      : null,
    products: plain.products,
    status: plain.status,
    payment_status: plain.paymentStatus,
    pickup_status: plain.pickupStatus,
    official_order_amount: plain.officialOrderAmount,
    official_order_amount_currency: plain.officialOrderAmountCurrency,
    official_order_amount_parse_error: plain.officialOrderAmountParseError,
    official_products: plain.officialProducts,
    validation_status: plain.validationStatus,
    validation_issues: plain.validationIssues,
    anomaly_detected_at: plain.anomalyDetectedAt,
    auto_refresh_enabled: plain.autoRefreshEnabled,
    auto_refresh_stop_reason: plain.autoRefreshStopReason,
    auto_refresh_stopped_at: plain.autoRefreshStoppedAt,
    order_url: plain.orderUrl,
    payment_method: plain.paymentMethod,
    pickup_store: plain.pickupStore,
    pickup_code: plain.pickupCode,
    order_date: plain.orderDate,
    order_placed_date: plain.orderPlacedDate,
    official_pickup_date: plain.officialPickupDate,
    actual_pickup_date: plain.actualPickupDate,
    last_crawled_at: plain.lastCrawledAt,
    crawl_fail_count: plain.crawlFailCount,
    tag: plain.tag,
    notes: plain.notes,
    created_at: plain.createdAt,
    updated_at: plain.updatedAt,
  };
}

/**
 * 解析并校验 query 中的筛选条件
 * @param {Object} query - req.query
 * @returns {Object} { where, page, limit }
 */
function buildListFilters(query) {
  const page = parsePositiveInt(query.page, { defaultValue: 1, min: 1, max: 100000 });
  const limit = parsePositiveInt(query.limit, { defaultValue: 20, min: 1, max: 100 });

  const where = {};

  if (query.status) {
    if (!ORDER_STATUSES.includes(query.status)) {
      throw ApiError.badRequest(
        `订单状态非法，可选值: ${ORDER_STATUSES.join(', ')}`,
        { received: query.status },
      );
    }
    where.status = query.status;
  }

  if (query.apple_id) {
    const appleIdInt = parseInt(query.apple_id, 10);
    if (Number.isNaN(appleIdInt) || appleIdInt <= 0) {
      throw ApiError.badRequest('apple_id 必须是正整数', { received: query.apple_id });
    }
    where.appleIdRef = appleIdInt;
  }

  if (query.recipient_id) {
    const recipientInt = parseInt(query.recipient_id, 10);
    if (Number.isNaN(recipientInt) || recipientInt <= 0) {
      throw ApiError.badRequest('recipient_id 必须是正整数', { received: query.recipient_id });
    }
    where.recipientRef = recipientInt;
  }

  if (query.date_from || query.date_to) {
    where.orderDate = {};
    if (query.date_from) {
      const from = new Date(query.date_from);
      if (Number.isNaN(from.getTime())) {
        throw ApiError.badRequest('date_from 不是合法日期', { received: query.date_from });
      }
      where.orderDate[Op.gte] = from;
    }
    if (query.date_to) {
      const to = new Date(query.date_to);
      if (Number.isNaN(to.getTime())) {
        throw ApiError.badRequest('date_to 不是合法日期', { received: query.date_to });
      }
      where.orderDate[Op.lte] = to;
    }
  }

  if (query.keyword) {
    const kw = String(query.keyword).trim();
    if (kw.length > 0) {
      // 订单号精确匹配（订单号是 ^W\\d{9}$）+ 产品名模糊匹配
      where[Op.or] = [
        { orderNumber: { [Op.iLike]: `%${kw}%` } },
        // Sequelize JSONB 容器查询（依赖 pg 的 @> 操作符）
        // 见 docs/DATABASE_SCHEMA.md：products 已建 GIN 索引
        // 此处若 keyword 命中订单号 iLike 会优先；同时模糊搜索 products[].name 在 PostgreSQL 上可行
      ];
      // 单独补充 products 容器查询：检测到数字 ID 直接精确
      const asOrderNumber = /^W\d{10}$/.test(kw);
      if (!asOrderNumber) {
        // 模糊搜索产品名称（通过 JSONB @> 包含含此 name 字符串的条目不可行，因此退化为 iLike 整个 products JSON 文本）
        where[Op.or].push(
          sequelizeJsonbTextSearch('products', kw),
        );
      }
    }
  }

  return { where, page, limit };
}

/**
 * 构造 Sequelize Op.contains 条件：匹配 products JSONB 数组中任一元素的 name 包含 keyword
 * 注意：[{ name: { [Op.iLike]: ... } }] 在 PostgreSQL 上需要逐项匹配会丢失数组语义，
 * 这里采用 products @> [{"name": "x"}] 的形态。完全匹配 name 而非 iLike；
 * 模糊匹配交给 orderNumber iLike 与 products 文本回退。
 * @param {string} kw - 搜索关键字
 * @returns {Object} Sequelize where 条件
 */
function sequelizeJsonbTextSearch(_fieldName, kw) {
  // 使用 PostgreSQL 函数 cast(products::text as text) iLike '%kw%'，
  // Sequelize 通过 literal 完成
  const { Sequelize } = require('sequelize');
  return Sequelize.where(
    Sequelize.fn('cast', Sequelize.col('products'), 'text'),
    { [Op.iLike]: `%${kw}%` },
  );
}

/**
 * GET /api/orders
 */
async function listOrders(req, res) {
  try {
    const { where, page, limit } = buildListFilters(req.query);

    const { count, rows } = await Order.findAndCountAll({
      where,
      include: [
        { model: AppleId, as: 'appleAccount', attributes: ['id', 'appleId', 'nickname'] },
        { model: Recipient, as: 'recipient', attributes: ['id', 'lastName', 'firstName', 'idCardLast4', 'tag'] },
      ],
      order: [['orderDate', 'DESC'], ['id', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    res.json(paginatedResponse(
      rows.map(serializeOrderListItem),
      count,
      page,
      limit,
      'orders',
    ));
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('查询订单列表失败', { error: error.message });
    throw ApiError.database('查询订单列表失败', { reason: error.message });
  }
}

/**
 * GET /api/orders/:id
 */
async function getOrderDetail(req, res) {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (Number.isNaN(orderId) || orderId <= 0) {
      throw ApiError.badRequest('订单 ID 必须是正整数', { received: req.params.id });
    }

    const order = await Order.findOne({
      where: { id: orderId },
      include: [
        { model: AppleId, as: 'appleAccount' },
        { model: Recipient, as: 'recipient' },
      ],
    });

    if (!order) {
      throw ApiError.notFound('订单不存在', { orderId });
    }

    res.json({ success: true, data: serializeOrderDetail(order) });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('查询订单详情失败', { orderId: req.params.id, error: error.message });
    throw ApiError.database('查询订单详情失败', { reason: error.message });
  }
}

/**
 * POST /api/orders/:id/refresh
 */
async function refreshOrder(req, res) {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (Number.isNaN(orderId) || orderId <= 0) {
      throw ApiError.badRequest('订单 ID 必须是正整数', { received: req.params.id });
    }

    const order = await Order.findByPk(orderId);
    if (!order) {
      throw ApiError.notFound('订单不存在', { orderId });
    }

    const oldStatus = order.status;
    const result = await crawlerService.crawlAndUpdateOrder(orderId, {
      source: 'manual',
      manual: true,
    });

    return res.json({
      success: true,
      message: '订单已更新',
      data: {
        id: orderId,
        order_number: order.orderNumber,
        old_status: oldStatus,
        new_status: result?.status ?? oldStatus,
        validation_status: result?.validationStatus ?? order.validationStatus,
        auto_refresh_stop_reason: result?.autoRefreshStopReason ?? null,
        updated: result || null,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('刷新订单失败', { orderId: req.params?.params?.id || req.params?.id, error: error.message });
    throw ApiError.crawler('刷新订单失败', { reason: error.message });
  }
}

/**
 * POST /api/orders/batch-refresh
 * body: { status?, apple_id?, recipient_id?, limit? }
 */
async function batchRefresh(req, res) {
  try {
    const where = {};
    if (req.body.status) {
      if (!ORDER_STATUSES.includes(req.body.status)) {
        throw ApiError.badRequest(
          `订单状态非法，可选值: ${ORDER_STATUSES.join(', ')}`,
          { received: req.body.status },
        );
      }
      where.status = req.body.status;
    }
    if (req.body.apple_id) {
      where.appleIdRef = parseInt(req.body.apple_id, 10);
    }
    if (req.body.recipient_id) {
      where.recipientRef = parseInt(req.body.recipient_id, 10);
    }

    const limit = parsePositiveInt(req.body.limit, { defaultValue: 20, min: 1, max: 100 });

    const orders = await Order.findAll({
      where,
      attributes: ['id', 'orderNumber', 'status'],
      limit,
      order: [['orderDate', 'ASC']],
    });

    if (orders.length === 0) {
      return res.json({
        success: true,
        message: '没有符合条件的订单',
        data: { total: 0, succeeded: 0, failed: 0, results: [] },
      });
    }

    const orderIds = orders.map((o) => o.id);
    const results = await crawlerService.crawlMultipleOrders(orderIds, {
      concurrency: 3,
      source: 'manual',
      manual: true,
    });

    const detailRows = results.details || [];
    const succeeded = detailRows.filter((r) => r.success).length;
    const failed = detailRows.filter((r) => !r.success).length;

    return res.json({
      success: true,
      message: `批量刷新完成，成功 ${succeeded} 个，失败 ${failed} 个`,
      data: {
        total: orderIds.length,
        succeeded,
        failed,
        results: detailRows,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('批量刷新订单失败', { error: error.message });
    throw ApiError.crawler('批量刷新订单失败', { reason: error.message });
  }
}

/**
 * PUT /api/orders/:id
 * 更新订单信息（付款人、付款截图）
 */
async function updateOrder(req, res) {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (Number.isNaN(orderId) || orderId <= 0) {
      throw ApiError.badRequest('订单 ID 必须是正整数', { received: req.params.id });
    }

    const order = await Order.findByPk(orderId);
    if (!order) {
      throw ApiError.notFound('订单不存在', { orderId });
    }

    // 允许更新的字段
    const allowedFields = ['payerName', 'paymentScreenshot'];
    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      throw ApiError.badRequest('没有可更新的字段', { allowedFields });
    }

    await order.update(updates);

    logger.info('订单更新成功', {
      orderId,
      orderNumber: order.orderNumber,
      updatedFields: Object.keys(updates),
    });

    res.json({
      success: true,
      message: '订单更新成功',
      data: {
        id: order.id,
        order_number: order.orderNumber,
        payer_name: order.payerName,
        payment_screenshot: order.paymentScreenshot,
        updated_at: order.updatedAt,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('更新订单失败', { orderId: req.params.id, error: error.message });
    throw ApiError.database('更新订单失败', { reason: error.message });
  }
}

module.exports = {
  listOrders,
  getOrderDetail,
  refreshOrder,
  batchRefresh,
  updateOrder,
};

// 防止 linter 报未使用变量（cron / EmailLog 暂未直接使用）
void EmailLog;
