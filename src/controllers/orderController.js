/* eslint-disable camelcase */
/**
 * 订单控制器
 * @module controllers/orderController
 * @description 订单列表 / 详情 / 手动刷新 / 批量刷新四个端点
 * @see docs/design/API设计.md
 */

const { Op } = require('sequelize');
const XLSX = require('xlsx');
const {
  Order,
  AppleId,
  Recipient,
  EmailLog,
  OrderRefreshSchedule,
  OrderRefreshJob,
} = require('../models');
const refreshJobService = require('../services/crawler/refreshJobService');
const { getDisplayedFreshness } = require('../services/crawler/refreshPolicy');
const logger = require('../utils/logger');
const {
  serializePublicProducts,
  serializeValidationIssues,
  serializeOfficialFields,
} = require('../utils/orderSerialization');
const ApiError = require('../utils/ApiError');
const { paginatedResponse, parsePositiveInt } = require('../utils/apiResponse');
const { ORDER_STATUSES, PERMISSIONS } = require('../constants/business');
const { maskIdCard, maskPhone, escapeSpreadsheetFormula } = require('../utils/masking');
const { canDisplayLocalSensitiveFields } = require('../utils/localSensitiveDisplay');

/**
 * 把 Order（含 appleAccount/recipient）序列化为对外列表项
 * @param {Order} order - Sequelize Order 实例
 * @param {boolean} includeRecipientPhone - 是否包含取机人手机号明文
 * @returns {Object} 列表项
 */
function serializeRefreshState(schedule, job, order) {
  const scheduleData = schedule?.toJSON ? schedule.toJSON() : schedule || {};
  const jobData = job?.toJSON ? job.toJSON() : job || null;
  return {
    freshness_status: getDisplayedFreshness(scheduleData, order),
    last_attempt_at: scheduleData.lastAttemptAt || null,
    last_success_at: scheduleData.lastSuccessAt || null,
    last_failure_at: scheduleData.lastFailureAt || null,
    last_error_code: scheduleData.lastErrorCode || null,
    last_error_message: scheduleData.lastErrorMessage || null,
    job: jobData ? { id: jobData.id, status: jobData.status, trigger: jobData.trigger } : null,
  };
}

function serializeOrderListItem(
  order,
  includeRecipientPhone = false,
  refreshSchedule = null,
  refreshJob = null
) {
  const plain = order.toJSON();
  return {
    id: plain.id,
    order_number: plain.orderNumber,
    apple_id: plain.appleAccount?.appleId || null,
    recipient_name: plain.recipient
      ? `${plain.recipient.lastName}${plain.recipient.firstName}`
      : null,
    products: serializePublicProducts(plain.products),
    ...serializeOfficialFields(plain),
    status: plain.status,
    payment_status: plain.paymentStatus,
    pickup_status: plain.pickupStatus,
    official_order_amount: plain.officialOrderAmount,
    official_order_amount_currency: plain.officialOrderAmountCurrency,
    official_order_amount_parse_error: plain.officialOrderAmountParseError,
    official_products: serializePublicProducts(plain.officialProducts),
    validation_status: plain.validationStatus,
    validation_issues: serializeValidationIssues(plain.validationIssues),
    anomaly_detected_at: plain.anomalyDetectedAt,
    auto_refresh_enabled: plain.autoRefreshEnabled,
    auto_refresh_stop_reason: plain.autoRefreshStopReason,
    auto_refresh_stopped_at: plain.autoRefreshStoppedAt,
    pickup_store: plain.pickupStore,
    recipient_id_card: maskIdCard(plain.recipientIdCard),
    recipient_email: plain.recipientEmail,
    recipient_phone: includeRecipientPhone ? plain.recipientPhone : maskPhone(plain.recipientPhone),
    recipient_address: plain.recipientAddress ? '详细地址已隐藏' : null,
    apple_password: null,
    order_url: null,
    pickup_store_code: plain.pickupStoreCode,
    pickup_code: plain.pickupCode,
    pickup_time_slot: plain.pickupTimeSlot,
    actual_pickup_date: plain.actualPickupDate,
    payment_method: plain.paymentMethod,
    payer_name: plain.payerName,
    payer_version: plain.payerVersion,
    payment_screenshot: plain.paymentScreenshot,
    order_date: plain.orderDate,
    last_crawled_at: plain.lastCrawledAt,
    crawl_fail_count: plain.crawlFailCount,
    tag: plain.tag,
    created_at: plain.createdAt,
    updated_at: plain.updatedAt,
    refresh: serializeRefreshState(refreshSchedule, refreshJob, plain),
  };
}

/**
 * 完整订单详情序列化
 * @param {Order} order - Sequelize Order 实例
 * @param {boolean} includeRecipientPhone - 是否包含取机人手机号明文
 * @returns {Object} 详情对象
 */
function serializeOrderDetail(
  order,
  includeRecipientPhone = false,
  refreshSchedule = null,
  refreshJob = null
) {
  const plain = order.toJSON();
  let appleId = null;
  if (plain.appleAccount) {
    appleId = {
      id: plain.appleAccount.id,
      apple_id: plain.appleAccount.appleId,
      nickname: plain.appleAccount.nickname,
    };
  }
  let recipient = null;
  if (plain.recipient) {
    recipient = {
      id: plain.recipient.id,
      name: `${plain.recipient.lastName}${plain.recipient.firstName}`,
      id_card_last4: plain.recipient.idCardLast4,
      tag: plain.recipient.tag,
      phone: includeRecipientPhone ? plain.recipient.phone : maskPhone(plain.recipient.phone),
    };
  }
  return {
    id: plain.id,
    order_number: plain.orderNumber,
    apple_id: appleId,
    recipient,
    products: serializePublicProducts(plain.products),
    ...serializeOfficialFields(plain),
    status: plain.status,
    payment_status: plain.paymentStatus,
    pickup_status: plain.pickupStatus,
    official_order_amount: plain.officialOrderAmount,
    official_order_amount_currency: plain.officialOrderAmountCurrency,
    official_order_amount_parse_error: plain.officialOrderAmountParseError,
    official_products: serializePublicProducts(plain.officialProducts),
    validation_status: plain.validationStatus,
    validation_issues: serializeValidationIssues(plain.validationIssues),
    anomaly_detected_at: plain.anomalyDetectedAt,
    auto_refresh_enabled: plain.autoRefreshEnabled,
    auto_refresh_stop_reason: plain.autoRefreshStopReason,
    auto_refresh_stopped_at: plain.autoRefreshStoppedAt,
    order_url: null,
    payment_method: plain.paymentMethod,
    payer_name: plain.payerName,
    payer_version: plain.payerVersion,
    payment_screenshot: plain.paymentScreenshot,
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
    refresh: serializeRefreshState(refreshSchedule, refreshJob, plain),
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
      throw ApiError.badRequest(`订单状态非法，可选值: ${ORDER_STATUSES.join(', ')}`, {
        received: query.status,
      });
    }
    where.status = query.status;
  }

  if (query.payment_status) {
    if (!['unknown', 'unpaid', 'paid', 'refunded'].includes(query.payment_status)) {
      throw ApiError.badRequest('payment_status 非法');
    }
    if (query.payment_status === 'unknown') {
      where[Op.and] = (where[Op.and] || []).concat({
        [Op.or]: [{ paymentStatus: 'unknown' }, { paymentStatus: null }, { paymentStatus: '' }],
      });
    } else {
      where.paymentStatus = query.payment_status;
    }
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

  if (query.pickupStore)
    where.pickupStore = { [Op.iLike]: `%${String(query.pickupStore).trim()}%` };
  if (query.payerName) where.payerName = { [Op.iLike]: `%${String(query.payerName).trim()}%` };
  if (query.productModel) {
    where[Op.and] = (where[Op.and] || []).concat(
      sequelizeJsonbTextSearch('products', String(query.productModel).trim())
    );
  }
  if (query.recipientName) {
    const { Sequelize } = require('sequelize');
    const recipientName = String(query.recipientName).trim();
    const currentAnd = where[Op.and] || [];
    where[Op.and] = currentAnd.concat(
      Sequelize.where(
        Sequelize.fn(
          'concat',
          Sequelize.col('recipient.last_name'),
          Sequelize.col('recipient.first_name')
        ),
        { [Op.iLike]: `%${recipientName}%` }
      )
    );
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
      // 订单号精确匹配（订单号是 ^W\\d{10}$）+ 产品名模糊匹配
      where[Op.or] = [
        { orderNumber: { [Op.iLike]: `%${kw}%` } },
        // Sequelize JSONB 容器查询（依赖 pg 的 @> 操作符）
        // 见 docs/database/数据库架构.md：products 已建 GIN 索引
        // 此处若 keyword 命中订单号 iLike 会优先；同时模糊搜索 products[].name 在 PostgreSQL 上可行
      ];
      // 单独补充 products 容器查询：检测到数字 ID 直接精确
      const asOrderNumber = /^W\d{10}$/.test(kw);
      if (!asOrderNumber) {
        // 模糊搜索产品名称（通过 JSONB @> 包含含此 name 字符串的条目不可行，因此退化为 iLike 整个 products JSON 文本）
        where[Op.or].push(sequelizeJsonbTextSearch('products', kw));
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
  // 使用 Sequelize.cast 生成 PostgreSQL CAST(products AS TEXT)。
  const { Sequelize } = require('sequelize');
  return Sequelize.where(Sequelize.cast(Sequelize.col('products'), 'text'), {
    [Op.iLike]: `%${kw}%`,
  });
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
        {
          model: Recipient,
          as: 'recipient',
          attributes: ['id', 'lastName', 'firstName', 'idCardLast4', 'tag'],
        },
      ],
      order: [
        ['orderDate', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    const includeRecipientPhone = canDisplayLocalSensitiveFields(
      req,
      PERMISSIONS.ORDERS_SECRETS_READ
    );
    const orderIds = rows.map(order => order.id);
    let schedules = [];
    let activeJobs = [];
    if (orderIds.length > 0) {
      [schedules, activeJobs] = await Promise.all([
        OrderRefreshSchedule.findAll({ where: { orderId: { [Op.in]: orderIds } } }),
        OrderRefreshJob.findAll({
          where: { orderId: { [Op.in]: orderIds }, status: { [Op.in]: ['pending', 'running'] } },
          order: [['priority', 'DESC']],
        }),
      ]);
    }
    const scheduleByOrder = new Map(schedules.map(schedule => [schedule.orderId, schedule]));
    const jobByOrder = new Map(activeJobs.map(job => [job.orderId, job]));
    res.json(
      paginatedResponse(
        rows.map(order =>
          serializeOrderListItem(
            order,
            includeRecipientPhone,
            scheduleByOrder.get(order.id),
            jobByOrder.get(order.id)
          )
        ),
        count,
        page,
        limit,
        'orders'
      )
    );
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

    const [refreshSchedule, refreshJob] = await Promise.all([
      OrderRefreshSchedule.findByPk(orderId),
      OrderRefreshJob.findOne({
        where: { orderId, status: { [Op.in]: ['pending', 'running'] } },
        order: [['priority', 'DESC']],
      }),
    ]);

    res.json({
      success: true,
      data: serializeOrderDetail(
        order,
        canDisplayLocalSensitiveFields(req, PERMISSIONS.ORDERS_SECRETS_READ),
        refreshSchedule,
        refreshJob
      ),
    });
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

    const result = await refreshJobService.enqueueOrderRefresh(orderId, {
      trigger: 'manual_single',
      requestedBy: req.user.id,
    });

    return res.status(202).json({
      success: true,
      message: result.created ? '刷新任务已提交' : '已有刷新任务，已复用',
      data: {
        orderId,
        order_number: order.orderNumber,
        jobId: result.job.id,
        status: result.job.status,
        created: result.created,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('刷新订单失败', {
      orderId: req.params?.params?.id || req.params?.id,
      error: error.message,
    });
    throw ApiError.database('提交刷新任务失败', { reason: error.message });
  }
}

/**
 * POST /api/orders/batch-refresh
 * body: { status?, apple_id?, recipient_id?, limit? }
 */
async function batchRefresh(req, res) {
  try {
    const where = {};
    const hasExplicitIds = Boolean(req.body.orderIds || req.body.order_ids);
    let explicitIds = [];
    if (hasExplicitIds) {
      const rawIds = req.body.orderIds || req.body.order_ids;
      if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100) {
        throw ApiError.badRequest('orderIds 必须是 1-100 个订单 ID 的数组');
      }
      explicitIds = rawIds.map(id => parseInt(id, 10));
      if (explicitIds.some(id => Number.isNaN(id) || id <= 0)) {
        throw ApiError.badRequest('orderIds 包含无效订单 ID');
      }
      explicitIds = [...new Set(explicitIds)];
      where.id = { [Op.in]: explicitIds };
    } else if (req.body.status) {
      if (!ORDER_STATUSES.includes(req.body.status)) {
        throw ApiError.badRequest(`订单状态非法，可选值: ${ORDER_STATUSES.join(', ')}`, {
          received: req.body.status,
        });
      }
      where.status = req.body.status;
    }
    if (!hasExplicitIds) {
      if (req.body.apple_id) {
        const appleIdRef = parseInt(req.body.apple_id, 10);
        if (Number.isNaN(appleIdRef) || appleIdRef <= 0) {
          throw ApiError.badRequest('apple_id 必须是正整数');
        }
        where.appleIdRef = appleIdRef;
      }
      if (req.body.recipient_id) {
        const recipientRef = parseInt(req.body.recipient_id, 10);
        if (Number.isNaN(recipientRef) || recipientRef <= 0) {
          throw ApiError.badRequest('recipient_id 必须是正整数');
        }
        where.recipientRef = recipientRef;
      }
    }

    const limit = hasExplicitIds
      ? explicitIds.length
      : parsePositiveInt(req.body.limit, { defaultValue: 20, min: 1, max: 100 });

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

    const orderIds = orders.map(order => order.id);
    const result = await refreshJobService.enqueueMany(orderIds, {
      trigger: 'manual_single',
      requestedBy: req.user.id,
    });

    return res.status(202).json({
      success: true,
      message: '批量刷新任务已提交',
      data: result,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('批量刷新订单失败', { error: error.message });
    throw ApiError.database('提交批量刷新任务失败', { reason: error.message });
  }
}

/**
 * POST /api/orders/refresh-all
 */
async function refreshAll(req, res) {
  try {
    const result = await refreshJobService.enqueueRefreshAll(req.user.id);
    return res.status(202).json({
      success: true,
      message: result.created ? '刷新全部批次已提交' : '已有刷新全部批次，已复用',
      data: { batchId: result.batch.id, status: result.batch.status, created: result.created },
    });
  } catch (error) {
    logger.error('提交刷新全部批次失败', { userId: req.user.id, error: error.message });
    throw ApiError.database('提交刷新全部批次失败', { reason: error.message });
  }
}

/**
 * POST /api/orders/page-open-refresh
 */
async function pageOpenRefresh(req, res) {
  try {
    const rawIds = req.body.order_ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100) {
      throw ApiError.badRequest('order_ids 必须是 1-100 个订单 ID 的数组');
    }
    const orderIds = [...new Set(rawIds.map(id => Number(id)))];
    if (orderIds.some(id => !Number.isInteger(id) || id <= 0)) {
      throw ApiError.badRequest('order_ids 包含无效订单 ID');
    }
    const result = await refreshJobService.enqueuePageOpenRefresh(orderIds, req.user.id);
    return res.status(202).json({ success: true, message: '页面刷新任务已提交', data: result });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('提交页面刷新任务失败', { userId: req.user.id, error: error.message });
    throw ApiError.database('提交页面刷新任务失败', { reason: error.message });
  }
}

/**
 * GET /api/orders/export
 * 按当前筛选条件导出脱敏订单。
 */
async function exportOrders(req, res) {
  try {
    const { where } = buildListFilters(req.query);
    const rows = await Order.findAll({
      where,
      include: [
        { model: AppleId, as: 'appleAccount', attributes: ['appleId'] },
        { model: Recipient, as: 'recipient', attributes: ['lastName', 'firstName'] },
      ],
      order: [
        ['orderDate', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: 5000,
    });
    const data = rows.map(order => {
      const item = serializeOrderListItem(order);
      return {
        订单号: escapeSpreadsheetFormula(item.order_number || ''),
        'Apple ID': escapeSpreadsheetFormula(item.apple_id || ''),
        取机人: escapeSpreadsheetFormula(item.recipient_name || ''),
        订单状态: item.status || '',
        支付状态: item.payment_status || '',
        取货状态: item.pickup_status || '',
        官网金额: item.official_order_amount || '',
        币种: item.official_order_amount_currency || '',
        取货门店: escapeSpreadsheetFormula(item.pickup_store || ''),
        标签: escapeSpreadsheetFormula(item.tag || ''),
        下单时间: item.order_date || '',
      };
    });
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '订单');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const filename = `orders_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    logger.info('订单导出完成', { userId: req.user.id, count: rows.length });
    res.send(buffer);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('订单导出失败', { userId: req.user?.id, error: error.message });
    throw ApiError.internal('订单导出失败', { reason: error.message });
  }
}

/**
 * 获取订单筛选项，数据只来自真实订单。
 * @param {Object} _req - Express request
 * @param {Object} res - Express response
 * @returns {Promise<void>}
 */
async function getFilterOptions(_req, res) {
  try {
    const rows = await Order.findAll({
      attributes: ['products', 'pickupStore', 'payerName', 'recipientName'],
      order: [['updatedAt', 'DESC']],
      limit: 5000,
      raw: true,
    });
    const productModels = new Set();
    const stores = new Set();
    const recipients = new Set();
    const payers = new Set();
    rows.forEach(row => {
      (row.products || []).forEach(product => {
        if (product.model || product.modelId) productModels.add(product.model || product.modelId);
      });
      if (row.pickupStore) stores.add(row.pickupStore);
      if (row.recipientName) recipients.add(row.recipientName);
      if (row.payerName) payers.add(row.payerName);
    });
    res.json({
      success: true,
      data: {
        productModels: [...productModels].sort(),
        stores: [...stores].sort(),
        recipients: [...recipients].sort(),
        payers: [...payers].sort(),
      },
    });
  } catch (error) {
    logger.error('获取订单筛选项失败', { error: error.message });
    throw ApiError.database('获取订单筛选项失败', { reason: error.message });
  }
}

/**
 * PUT /api/orders/:id
 * 更新订单付款截图；付款人必须使用专用关联端点。
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
    const allowedFields = ['paymentScreenshot'];
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
  buildListFilters,
  listOrders,
  getOrderDetail,
  refreshOrder,
  batchRefresh,
  refreshAll,
  pageOpenRefresh,
  exportOrders,
  getFilterOptions,
  updateOrder,
};

// 防止 linter 报未使用变量（cron / EmailLog 暂未直接使用）
void EmailLog;
