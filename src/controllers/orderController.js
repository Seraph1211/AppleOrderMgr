const { buildOrderProductCondition } = require('../utils/productFilterQuery');
const { collectProductOptions } = require('../utils/productFilter');
const { buildOrderDateCondition } = require('../utils/orderDateFilter');
const { formatOrderTime } = require('../utils/orderTime');
/* eslint-disable camelcase */
/**
 * 订单控制器
 * @module controllers/orderController
 * @description 订单列表 / 详情 / 手动刷新 / 批量刷新四个端点
 * @see docs/design/API设计.md
 */

const { Op, Sequelize } = require('sequelize');
const XLSX = require('xlsx');
const {
  Order,
  AppleId,
  Recipient,
  EmailLog,
  OrderRefreshSchedule,
  OrderRefreshJob,
  sequelize,
} = require('../models');
const refreshJobService = require('../services/crawler/refreshJobService');
const { getDisplayedFreshness } = require('../services/crawler/refreshPolicy');
const { scopeOrderWhere, assertOrderIdsAccess } = require('../services/orderAccessService');
const logger = require('../utils/logger');
const {
  serializePublicProducts,
  serializeValidationIssues,
  serializeOfficialFields,
  serializeOrderPricingFields,
  serializeEmailLifecycleFields,
} = require('../utils/orderSerialization');
const ApiError = require('../utils/ApiError');
const { paginatedResponse, parsePositiveInt } = require('../utils/apiResponse');
const { ORDER_STATUSES, PERMISSIONS, normalizeOrderStatus } = require('../constants/business');
const { buildOrderStatusCondition } = require('../utils/orderStatusFilter');
const { maskIdCard, maskPhone, escapeSpreadsheetFormula } = require('../utils/masking');
const { canDisplayLocalSensitiveFields } = require('../utils/localSensitiveDisplay');
const {
  formatPickupDate,
  formatPickupTime,
  formatPickupTimeSlot,
  normalizePickupDate,
} = require('../utils/orderPickupTime');

const MAX_MULTI_SELECT_ITEMS = 100;
const MAX_FILTER_VALUE_LENGTH = 255;
const MAX_ORDER_EXPORT_IDS = 100;
const MAX_ORDER_ID = 2147483647;

const ORDER_EXPORT_FIELDS = Object.freeze({
  systemOrderId: { label: '系统订单 ID', value: item => item.id },
  orderNumber: { label: '官网订单号', value: item => item.order_number || '' },
  ingestionSource: {
    label: '入库来源',
    value: item => ({ aos: 'AOS 文件', email: '邮件' })[item.ingestion_source] || '来源未知',
  },
  appleId: { label: 'Apple ID', value: item => item.apple_id || '' },
  recipientName: { label: '取机人', value: item => item.recipient_name || '' },
  recipientTag: { label: '取机人 TAG', value: item => item.recipient_tag || '' },
  products: {
    label: '商品信息',
    value: item =>
      (item.products || [])
        .map(product => {
          const name = product.name || product.model || '-';
          const quantity = Number.isInteger(product.quantity) ? product.quantity : '待核实';
          return `${name} ×${quantity}`;
        })
        .join('、'),
  },
  emailOrderStatus: { label: '邮件订单状态', value: item => item.email_order_status || 'unknown' },
  emailPaymentStatus: {
    label: '邮件付款状态',
    value: item => item.email_payment_status || 'unknown',
  },
  emailStatusNeedsReview: {
    label: '邮件状态待核对',
    value: item => (item.email_status_needs_review ? '是' : '否'),
  },
  officialOrderStatus: { label: '官网订单状态', value: item => item.status || '' },
  officialPaymentStatus: { label: '官网支付状态', value: item => item.payment_status || '' },
  pickupStatus: { label: '取货状态', value: item => item.pickup_status || '' },
  orderAmount: { label: '订单金额', value: item => item.order_amount ?? '待确认' },
  currency: { label: '币种', value: item => item.order_amount_currency || '' },
  amountSource: { label: '金额来源', value: () => '按官方售价计算' },
  priceVersion: { label: '价格版本', value: item => item.order_amount_price_version || '' },
  emailPickupStore: {
    label: '邮件取货门店',
    value: item => item.email_pickup_info?.storeName || '',
  },
  emailPickupDate: { label: '邮件取货日期', value: item => item.email_pickup_date || '' },
  emailPickupSchedule: {
    label: '邮件取货安排',
    value: item => {
      const pickup = item.email_pickup_info;
      if (!pickup) return '';
      const pickupDate = pickup.pickupDate || item.email_pickup_date || '';
      const timeRange = [pickup.startTime, pickup.endTime].filter(Boolean).join('–');
      const arrangement =
        pickup.appointmentMode === 'business_hours' ? '营业时间内到店' : timeRange;
      return [pickupDate, arrangement].filter(Boolean).join(' ');
    },
  },
  pickupStore: { label: '官网取货门店', value: item => item.pickup_store || '' },
  pickupStoreCode: { label: '门店代码', value: item => item.pickup_store_code || '' },
  pickupCode: { label: '取货码', value: item => item.pickup_code || '' },
  pickupTime: { label: '取货时间', value: item => item.pickup_time || '' },
  actualPickupDate: { label: '实际取货日期', value: item => item.actual_pickup_date || '' },
  paymentMethod: { label: '付款方式', value: item => item.payment_method || '' },
  payerName: { label: '付款人', value: item => item.payer_name || '' },
  tag: { label: '标签', value: item => item.tag || '' },
  notes: { label: '备注', value: item => item.notes || '' },
  orderDate: {
    label: '下单时间（北京时间，来源记录）',
    value: item => formatOrderTime(item.order_date),
  },
  lastOfficialUpdatedAt: {
    label: '最后更新时间（北京时间）',
    value: item => formatOrderTime(item.last_crawled_at),
  },
  createdAt: {
    label: '创建时间（北京时间）',
    value: item => formatOrderTime(item.created_at),
  },
  updatedAt: {
    label: '更新时间（北京时间）',
    value: item => formatOrderTime(item.updated_at),
  },
  crawlFailCount: { label: '爬取失败次数', value: item => item.crawl_fail_count ?? 0 },
});

const LEGACY_ORDER_EXPORT_FIELDS = Object.freeze([
  'orderNumber',
  'appleId',
  'recipientName',
  'emailOrderStatus',
  'emailPaymentStatus',
  'emailStatusNeedsReview',
  'officialOrderStatus',
  'officialPaymentStatus',
  'pickupStatus',
  'orderAmount',
  'currency',
  'amountSource',
  'priceVersion',
  'emailPickupStore',
  'emailPickupDate',
  'pickupStore',
  'tag',
  'orderDate',
]);

function getPickupReferenceTime(order) {
  return order.officialStatusObservedAt || order.lastCrawledAt || null;
}

function serializePickupFields(order) {
  const referenceTime = getPickupReferenceTime(order);
  return {
    pickup_time: formatPickupTime(order.officialFulfillmentMessage, referenceTime),
    official_pickup_date: formatPickupDate(order.officialFulfillmentMessage, referenceTime),
    official_pickup_time_slot: formatPickupTimeSlot(
      order.officialFulfillmentMessage,
      referenceTime
    ),
  };
}

function serializeOfficialProductsWithPickup(order) {
  const referenceTime = getPickupReferenceTime(order);
  return serializePublicProducts(order.officialProducts).map(product => ({
    ...product,
    pickupTime: formatPickupTime(product.fulfillmentMessage, referenceTime),
  }));
}

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

/**
 * 序列化订单列表，关联档案缺失时保留邮件入库信息。
 * @param {Object} order - 订单模型
 * @param {boolean} includeRecipientPhone - 是否允许读取明文电话
 * @param {Object|null} refreshSchedule - 刷新计划
 * @param {Object|null} refreshJob - 最新刷新任务
 * @returns {Object} 订单列表 DTO
 */
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
    ingestion_source: plain.ingestionSource || 'unknown',
    source_recipient_tag: plain.sourceRecipientTag || null,
    recipient_profile_tag: plain.recipient?.tag || null,
    recipient_linked: Boolean(plain.recipientRef),
    recipient_tag_conflict: Boolean(
      plain.ingestionSource === 'aos' &&
      plain.recipient?.tag &&
      plain.sourceRecipientTag &&
      plain.recipient.tag !== plain.sourceRecipientTag
    ),
    apple_id: plain.appleAccount?.appleId || plain.appleId || null,
    recipient_name: plain.recipient
      ? `${plain.recipient.lastName || ''}${plain.recipient.firstName || ''}` || plain.recipientName
      : plain.recipientName || null,
    recipient_tag:
      plain.ingestionSource === 'aos'
        ? plain.sourceRecipientTag || plain.recipient?.tag || plain.tag || null
        : plain.recipient?.tag || plain.tag || null,
    products: serializePublicProducts(plain.products, plain.productFilterItems),
    ...serializeOfficialFields(plain),
    ...serializeOrderPricingFields(plain),
    ...serializeEmailLifecycleFields(plain),
    status: normalizeOrderStatus(plain.status),
    payment_status: plain.paymentStatus,
    pickup_status: plain.pickupStatus,
    official_order_amount: plain.officialOrderAmount,
    official_order_amount_currency: plain.officialOrderAmountCurrency,
    official_order_amount_parse_error: plain.officialOrderAmountParseError,
    official_products: serializeOfficialProductsWithPickup(plain),
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
    ...serializePickupFields(plain),
    actual_pickup_date: plain.actualPickupDate,
    payment_method: plain.paymentMethod,
    payer_name: plain.payerName,
    payer_version: plain.payerVersion,
    payment_screenshot: plain.paymentScreenshot,
    order_date: plain.orderDate,
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
  if (!appleId && plain.appleId) appleId = { id: null, apple_id: plain.appleId, nickname: null };
  let recipient = null;
  if (plain.recipient) {
    recipient = {
      id: plain.recipient.id,
      name:
        `${plain.recipient.lastName || ''}${plain.recipient.firstName || ''}` ||
        plain.recipientName ||
        null,
      id_card_last4: plain.recipient.idCardLast4,
      tag: plain.recipient.tag || plain.tag || null,
      phone: includeRecipientPhone ? plain.recipient.phone : maskPhone(plain.recipient.phone),
    };
  }
  if (!recipient && plain.recipientName) {
    recipient = {
      id: null,
      name: plain.recipientName,
      id_card_last4: null,
      tag: plain.tag || null,
      phone: includeRecipientPhone ? plain.recipientPhone : maskPhone(plain.recipientPhone),
    };
  }
  return {
    id: plain.id,
    order_number: plain.orderNumber,
    ingestion_source: plain.ingestionSource || 'unknown',
    source_recipient_tag: plain.sourceRecipientTag || null,
    recipient_profile_tag: plain.recipient?.tag || null,
    recipient_linked: Boolean(plain.recipientRef),
    recipient_tag_conflict: Boolean(
      plain.ingestionSource === 'aos' &&
      plain.recipient?.tag &&
      plain.sourceRecipientTag &&
      plain.recipient.tag !== plain.sourceRecipientTag
    ),
    apple_id: appleId,
    recipient_email: plain.recipientEmail,
    recipient_phone: includeRecipientPhone ? plain.recipientPhone : maskPhone(plain.recipientPhone),
    recipient,
    recipient_tag:
      plain.ingestionSource === 'aos'
        ? plain.sourceRecipientTag || plain.recipient?.tag || plain.tag || null
        : plain.recipient?.tag || plain.tag || null,
    products: serializePublicProducts(plain.products, plain.productFilterItems),
    ...serializeOfficialFields(plain),
    ...serializeOrderPricingFields(plain),
    ...serializeEmailLifecycleFields(plain),
    status: normalizeOrderStatus(plain.status),
    payment_status: plain.paymentStatus,
    pickup_status: plain.pickupStatus,
    official_order_amount: plain.officialOrderAmount,
    official_order_amount_currency: plain.officialOrderAmountCurrency,
    official_order_amount_parse_error: plain.officialOrderAmountParseError,
    official_products: serializeOfficialProductsWithPickup(plain),
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
    pickup_store_code: plain.pickupStoreCode,
    pickup_code: plain.pickupCode,
    pickup_time_slot: plain.pickupTimeSlot,
    ...serializePickupFields(plain),
    order_date: plain.orderDate,
    order_placed_date: plain.orderPlacedDate,
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
 * 解析并校验查询中的单值或 JSON 数组多选参数。
 * @param {unknown} rawValue - 原始查询参数
 * @param {string} fieldName - 错误信息中的字段名
 * @param {Object} options - 白名单、数量和长度限制
 * @returns {string[]} 去重并去除首尾空白的值
 */
function parseMultiSelectFilter(
  rawValue,
  fieldName,
  {
    allowedValues = null,
    maxItems = MAX_MULTI_SELECT_ITEMS,
    maxLength = MAX_FILTER_VALUE_LENGTH,
    trimValues = true,
  } = {}
) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return [];
  let values = rawValue;
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        values = JSON.parse(trimmed);
      } catch (_error) {
        throw ApiError.badRequest(`${fieldName} 必须是合法数组`);
      }
    } else {
      values = [trimmed];
    }
  }
  if (!Array.isArray(values)) throw ApiError.badRequest(`${fieldName} 必须是合法数组`);
  if (values.length > maxItems) throw ApiError.badRequest(`${fieldName} 最多选择 ${maxItems} 项`);
  if (values.some(value => typeof value !== 'string')) {
    throw ApiError.badRequest(`${fieldName} 每项必须是字符串`);
  }
  const normalized = [
    ...new Set(values.map(value => (trimValues ? value.trim() : value)).filter(Boolean)),
  ];
  if (normalized.some(value => value.length > maxLength)) {
    throw ApiError.badRequest(`${fieldName} 每项不能超过 ${maxLength} 字符`);
  }
  if (allowedValues && normalized.some(value => !allowedValues.includes(value))) {
    throw ApiError.badRequest(`${fieldName} 包含非法值`);
  }
  return normalized;
}

// 与列表 recipient_tag 的来源回退顺序一致，保留非空 TAG 的原始值。
const RECIPIENT_TAG_EXPRESSION = Sequelize.literal(`CASE
  WHEN "Order"."ingestion_source" = 'aos'
    THEN COALESCE(NULLIF("Order"."source_recipient_tag", ''), NULLIF("recipient"."tag", ''), NULLIF("Order"."tag", ''))
  ELSE COALESCE(NULLIF("recipient"."tag", ''), NULLIF("Order"."tag", ''))
END`);

/** 构造商品完整名称多选条件。 */
function buildProductNamesCondition(productNames) {
  if (productNames.length === 0) return null;
  const escapedNames = productNames.map(name => sequelize.escape(name)).join(', ');
  return Sequelize.literal(`EXISTS (
    SELECT 1
    FROM jsonb_array_elements("products") AS item
    WHERE item->>'name' IN (${escapedNames})
  )`);
}

/**
 * 解析并校验 query 中的筛选条件。
 * @param {Object} query - req.query
 * @returns {Object} { where, page, limit }
 */
function buildListFilters(query) {
  const page = parsePositiveInt(query.page, { defaultValue: 1, min: 1, max: 100000 });
  const limit = parsePositiveInt(query.limit, { defaultValue: 20, min: 1, max: 100 });

  const where = {};

  const statuses = parseMultiSelectFilter(query.statuses ?? query.status, 'statuses', {
    allowedValues: ORDER_STATUSES,
    maxLength: 50,
  });
  if (statuses.length > 0) {
    where.status =
      statuses.length === 1 && statuses[0] !== 'unknown'
        ? statuses[0]
        : buildOrderStatusCondition(statuses);
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
  const emailOrderStatuses = parseMultiSelectFilter(
    query.emailOrderStatuses,
    'emailOrderStatuses',
    {
      allowedValues: ['unknown', 'confirmed', 'processing', 'ready_for_pickup'],
      maxLength: 30,
    }
  );
  if (emailOrderStatuses.length) where.emailOrderStatus = { [Op.in]: emailOrderStatuses };
  const emailPaymentStatuses = parseMultiSelectFilter(
    query.emailPaymentStatuses,
    'emailPaymentStatuses',
    { allowedValues: ['unknown', 'paid'], maxLength: 20 }
  );
  if (emailPaymentStatuses.length) where.emailPaymentStatus = { [Op.in]: emailPaymentStatuses };

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

  const recipientTags = parseMultiSelectFilter(query.recipientTags, 'recipientTags', {
    trimValues: false,
  });
  if (recipientTags.length > 0) {
    where[Op.and] = (where[Op.and] || []).concat(
      Sequelize.where(RECIPIENT_TAG_EXPRESSION, { [Op.in]: recipientTags })
    );
  }

  const pickupStores = parseMultiSelectFilter(query.pickupStores, 'pickupStores');
  if (pickupStores.length > 0) where.pickupStore = { [Op.in]: pickupStores };
  else if (query.pickupStore)
    where.pickupStore = { [Op.iLike]: `%${String(query.pickupStore).trim()}%` };
  if (query.payerName) where.payerName = { [Op.iLike]: `%${String(query.payerName).trim()}%` };
  const productNames = parseMultiSelectFilter(query.productNames, 'productNames');
  const productNamesCondition =
    buildOrderProductCondition(query, sequelize, productNames) ||
    buildProductNamesCondition(productNames);
  if (productNamesCondition) {
    where[Op.and] = (where[Op.and] || []).concat(productNamesCondition);
  } else if (query.productModel) {
    where[Op.and] = (where[Op.and] || []).concat(
      sequelizeJsonbTextSearch('products', String(query.productModel).trim())
    );
  }
  if (query.pickupDate !== undefined && query.pickupDate !== '') {
    const pickupDate = normalizePickupDate(query.pickupDate);
    if (!pickupDate) throw ApiError.badRequest('pickupDate 必须是有效的 YYYY-MM-DD 日期');
    const isoPickupDate = pickupDate.replaceAll('/', '-');
    const referenceDateSql =
      '(COALESCE("official_status_observed_at", "last_crawled_at") ' +
      "AT TIME ZONE 'Asia/Shanghai')::date";
    where[Op.and] = (where[Op.and] || []).concat({
      [Op.or]: [
        { officialFulfillmentMessage: { [Op.iLike]: `%${pickupDate}%` } },
        {
          [Op.and]: [
            { officialFulfillmentMessage: { [Op.iLike]: '%今天%' } },
            Sequelize.literal(`${referenceDateSql} = ${sequelize.escape(isoPickupDate)}::date`),
          ],
        },
        {
          [Op.and]: [
            { officialFulfillmentMessage: { [Op.iLike]: '%明天%' } },
            Sequelize.literal(
              `${referenceDateSql} + INTERVAL '1 day' = ${sequelize.escape(isoPickupDate)}::date`
            ),
          ],
        },
      ],
    });
  }
  if (query.recipientName) {
    const recipientName = String(query.recipientName).trim();
    const currentAnd = where[Op.and] || [];
    where[Op.and] = currentAnd.concat({
      [Op.or]: [
        { recipientName: { [Op.iLike]: `%${recipientName}%` } },
        Sequelize.where(
          Sequelize.fn(
            'concat',
            Sequelize.col('recipient.last_name'),
            Sequelize.col('recipient.first_name')
          ),
          { [Op.iLike]: `%${recipientName}%` }
        ),
      ],
    });
  }

  const orderDateCondition = buildOrderDateCondition(query);
  if (orderDateCondition) where.orderDate = orderDateCondition;

  if (query.keyword) {
    const kw = String(query.keyword).trim();
    if (kw.length > 0) {
      // 系统订单 ID 精确匹配，并保留官网订单号及既有文本模糊搜索。
      where[Op.or] = [
        { orderNumber: { [Op.iLike]: `%${kw}%` } },
        { appleId: { [Op.iLike]: `%${kw}%` } },
        { recipientName: { [Op.iLike]: `%${kw}%` } },
        { '$appleAccount.apple_id$': { [Op.iLike]: `%${kw}%` } },
        { '$recipient.last_name$': { [Op.iLike]: `%${kw}%` } },
        { '$recipient.first_name$': { [Op.iLike]: `%${kw}%` } },
        // Sequelize JSONB 容器查询（依赖 pg 的 @> 操作符）
        // 见 docs/database/数据库架构.md：products 已建 GIN 索引
        // 此处若 keyword 命中订单号 iLike 会优先；同时模糊搜索 products[].name 在 PostgreSQL 上可行
      ];
      if (/^\d+$/.test(kw)) {
        const systemOrderId = Number(kw);
        if (
          Number.isSafeInteger(systemOrderId) &&
          systemOrderId > 0 &&
          systemOrderId <= MAX_ORDER_ID
        ) {
          where[Op.or].push({ id: systemOrderId });
        }
      }
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
      where: scopeOrderWhere(req.user, where),
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
      where: scopeOrderWhere(req.user, { id: orderId }),
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
 * GET /api/orders/:id/link
 * 按订单读取范围返回单个官网订单链接，不在列表和导出中常驻。
 */
async function getOrderLink(req, res) {
  try {
    const rawOrderId = String(req.params.id || '');
    const orderId = Number(rawOrderId);
    if (
      !/^\d+$/.test(rawOrderId) ||
      !Number.isSafeInteger(orderId) ||
      orderId <= 0 ||
      orderId > MAX_ORDER_ID
    ) {
      throw ApiError.badRequest('订单 ID 必须是正整数', { received: req.params.id });
    }
    const order = await Order.findOne({
      where: scopeOrderWhere(req.user, { id: orderId }),
      attributes: ['id', 'orderNumber', 'orderUrl'],
    });
    if (!order) throw ApiError.notFound('订单不存在');
    if (!order.orderUrl) throw ApiError.notFound('订单链接不存在');
    req.auditTarget = `订单；目标编号 ${order.id}`;
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      data: { id: order.id, orderNumber: order.orderNumber, orderUrl: order.orderUrl },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('读取订单链接失败', { orderId: req.params.id, error: error.message });
    throw ApiError.database('读取订单链接失败', { reason: error.message });
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

    const order = await Order.findOne({ where: scopeOrderWhere(req.user, { id: orderId }) });
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
    const hasExplicitIds = req.body.orderIds !== undefined || req.body.order_ids !== undefined;
    let explicitIds = [];
    if (hasExplicitIds) {
      const rawIds = req.body.orderIds !== undefined ? req.body.orderIds : req.body.order_ids;
      if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100) {
        throw ApiError.badRequest('orderIds 必须是 1-100 个订单 ID 的数组');
      }
      if (
        rawIds.some(
          id =>
            !(
              (typeof id === 'number' || typeof id === 'string') &&
              /^\d+$/.test(String(id)) &&
              Number.isSafeInteger(Number(id)) &&
              Number(id) > 0
            )
        )
      ) {
        throw ApiError.badRequest('orderIds 包含无效订单 ID');
      }
      explicitIds = rawIds.map(Number);
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
      where: scopeOrderWhere(req.user, where),
      attributes: ['id', 'orderNumber', 'status'],
      limit,
      order: [['orderDate', 'ASC']],
    });

    if (orders.length === 0 && !hasExplicitIds) {
      return res.json({
        success: true,
        message: '没有符合条件的订单',
        data: { total: 0, succeeded: 0, failed: 0, results: [] },
      });
    }

    const orderIds = hasExplicitIds ? explicitIds : orders.map(order => order.id);
    await assertOrderIdsAccess(req.user, orderIds);
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
    const result = await refreshJobService.enqueueRefreshAll(req.user.id, req.user);
    return res.status(202).json({
      success: true,
      message: result.created ? '刷新全部批次已提交' : '已有刷新全部批次，已复用',
      data: { batchId: result.batch.id, status: result.batch.status, created: result.created },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
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
    await assertOrderIdsAccess(req.user, orderIds);
    const result = await refreshJobService.enqueuePageOpenRefresh(orderIds, req.user.id);
    return res.status(202).json({ success: true, message: '页面刷新任务已提交', data: result });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('提交页面刷新任务失败', { userId: req.user.id, error: error.message });
    throw ApiError.database('提交页面刷新任务失败', { reason: error.message });
  }
}

function parseOrderExportIds(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  let values = rawValue;
  if (typeof rawValue === 'string') {
    try {
      values = JSON.parse(rawValue);
    } catch (_error) {
      throw ApiError.badRequest('orderIds 必须是合法数组');
    }
  }
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ORDER_EXPORT_IDS) {
    throw ApiError.badRequest(`orderIds 必须是 1-${MAX_ORDER_EXPORT_IDS} 个订单 ID 的数组`);
  }
  if (
    values.some(
      value =>
        !/^\d+$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) <= 0 ||
        Number(value) > MAX_ORDER_ID
    )
  ) {
    throw ApiError.badRequest('orderIds 包含无效订单 ID');
  }
  const ids = values.map(Number);
  if (new Set(ids).size !== ids.length) throw ApiError.badRequest('orderIds 不能包含重复值');
  return ids;
}

function parseOrderExportFields(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return [...LEGACY_ORDER_EXPORT_FIELDS];
  }
  const fields = parseMultiSelectFilter(rawValue, 'fields', {
    allowedValues: Object.keys(ORDER_EXPORT_FIELDS),
    maxItems: Object.keys(ORDER_EXPORT_FIELDS).length,
    maxLength: 50,
  });
  if (fields.length === 0) throw ApiError.badRequest('fields 至少选择一项');
  return fields;
}

function createOrderExportRow(item, fields) {
  return Object.fromEntries(
    fields.map(field => {
      const definition = ORDER_EXPORT_FIELDS[field];
      const value = definition.value(item);
      return [
        definition.label,
        typeof value === 'string' ? escapeSpreadsheetFormula(value) : value,
      ];
    })
  );
}

/**
 * GET /api/orders/export
 * 按当前筛选条件或明确订单 ID 导出服务端白名单字段。
 */
async function exportOrders(req, res) {
  try {
    const { where } = buildListFilters(req.query);
    const orderIds = parseOrderExportIds(req.query.orderIds ?? req.query.order_ids);
    const fields = parseOrderExportFields(req.query.fields);
    if (orderIds) where.id = { [Op.in]: orderIds };
    const rows = await Order.findAll({
      where: scopeOrderWhere(req.user, where),
      include: [
        { model: AppleId, as: 'appleAccount', attributes: ['appleId'] },
        { model: Recipient, as: 'recipient', attributes: ['lastName', 'firstName', 'tag'] },
      ],
      order: [
        ['orderDate', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    if (orderIds && rows.length !== orderIds.length) {
      throw ApiError.notFound('订单不存在或不可访问');
    }
    const data = rows.map(order => createOrderExportRow(serializeOrderListItem(order), fields));
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
    logger.info('订单导出完成', {
      userId: req.user.id,
      count: rows.length,
      fieldCount: fields.length,
      selectedExport: Boolean(orderIds),
    });
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
async function getFilterOptions(req, res) {
  try {
    const rows = await Order.findAll({
      where: scopeOrderWhere(
        req.user,
        buildListFilters({
          ...req.query,
          productKeys: undefined,
          productNames: undefined,
          productModel: undefined,
        }).where
      ),
      include: [
        { model: Recipient, as: 'recipient', attributes: [] },
        { model: AppleId, as: 'appleAccount', attributes: [] },
      ],
      attributes: ['products', 'productFilterItems', 'pickupStore', 'payerName', 'recipientName'],
      order: [['updatedAt', 'DESC']],
      raw: true,
    });
    const tagRows = await Order.findAll({
      where: scopeOrderWhere(req.user),
      attributes: [[Sequelize.fn('DISTINCT', RECIPIENT_TAG_EXPRESSION), 'recipientTag']],
      include: [{ model: Recipient, as: 'recipient', attributes: [] }],
      raw: true,
    });
    const recipientTags = tagRows.map(row => row.recipientTag).filter(Boolean);
    const productModels = new Set();
    const productNames = new Set();
    const stores = new Set();
    const recipients = new Set();
    const payers = new Set();
    rows.forEach(row => {
      (row.products || []).forEach(product => {
        if (product.model || product.modelId) productModels.add(product.model || product.modelId);
        if (product.name) productNames.add(product.name);
      });
      if (row.pickupStore) stores.add(row.pickupStore);
      if (row.recipientName) recipients.add(row.recipientName);
      if (row.payerName) payers.add(row.payerName);
    });
    res.json({
      success: true,
      data: {
        recipientTags: [...new Set(recipientTags)].sort((left, right) =>
          left.localeCompare(right, 'zh-CN')
        ),
        productOptions: collectProductOptions(rows),
        productModels: [...productModels].sort(),
        productNames: [...productNames].sort((left, right) => left.localeCompare(right, 'zh-CN')),
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

    const order = await Order.findOne({ where: scopeOrderWhere(req.user, { id: orderId }) });
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
  serializeOrderListItem,
  serializeOrderDetail,
  parseMultiSelectFilter,
  buildListFilters,
  listOrders,
  getOrderDetail,
  getOrderLink,
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
