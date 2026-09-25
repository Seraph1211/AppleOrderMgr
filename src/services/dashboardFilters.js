const { Op, Sequelize } = require('sequelize');
const { sequelize } = require('../models');
const { EMAIL_ORDER_STATUSES } = require('../constants/business');
const { getOrderTagBind } = require('./orderAccessService');
const { buildOrderDateCondition } = require('../utils/orderDateFilter');
const { parseProductKeys, productKeySql } = require('../utils/productFilterQuery');
const ApiError = require('../utils/ApiError');

const MAX_FILTER_ITEMS = 100;
const MAX_FILTER_TEXT_LENGTH = 500;
const STATUS_MAP = {
  待确认: 'unknown',
  已确认: 'confirmed',
  处理中: 'processing',
  可取货: 'ready_for_pickup',
  '已取货（邮件推定）': 'picked_up',
};
// 与订单管理页 recipient_tag 相同；子查询避免聚合 JOIN 产生重复计数。
const PROFILE_TAG_SQL = '(SELECT r.tag FROM recipients r WHERE r.id = "Order".recipient_ref)';
const RECIPIENT_TAG_SQL = `CASE WHEN "Order".ingestion_source = 'aos'
  THEN COALESCE(NULLIF("Order".source_recipient_tag, ''),
    NULLIF(${PROFILE_TAG_SQL}, ''), NULLIF("Order".tag, ''))
  ELSE COALESCE(NULLIF(${PROFILE_TAG_SQL}, ''), NULLIF("Order".tag, '')) END`;

function parseList(value, field, allowedValues) {
  if (value === undefined || value === '') return [];
  let values = value;
  if (typeof value === 'string') {
    try {
      values = JSON.parse(value);
    } catch (_error) {
      throw ApiError.badRequest(`${field} 必须是合法数组`);
    }
  }
  if (
    !Array.isArray(values) ||
    values.length > MAX_FILTER_ITEMS ||
    values.some(
      item =>
        typeof item !== 'string' ||
        !item.trim() ||
        item.length > MAX_FILTER_TEXT_LENGTH ||
        (allowedValues && !allowedValues.includes(item))
    )
  ) {
    throw ApiError.badRequest(`${field} 包含非法值或超过 100 项`);
  }
  return [...new Set(values)];
}

/** 校验新旧仪表板参数；不接收客户端传入的权限对象。 */
function parseDashboardFilters(query = {}, orderUser) {
  const filters = { orderUser };
  for (const key of ['startDate', 'endDate', 'status', 'productModel', 'store']) {
    if (query[key] === undefined || query[key] === '') continue;
    if (typeof query[key] !== 'string' || query[key].length > MAX_FILTER_TEXT_LENGTH)
      throw ApiError.badRequest(`${key} 格式非法`);
    filters[key] = query[key];
  }
  for (const key of ['startDate', 'endDate']) {
    if (filters[key] && !/^\d{4}-\d{2}-\d{2}$/.test(filters[key]))
      throw ApiError.badRequest('下单日期应为 YYYY-MM-DD');
  }
  buildOrderDateCondition({ dateFrom: filters.startDate, dateTo: filters.endDate });
  if (filters.status) {
    filters.status = STATUS_MAP[filters.status] || filters.status;
    if (!EMAIL_ORDER_STATUSES.includes(filters.status)) throw ApiError.badRequest('订单状态非法');
  }
  filters.emailOrderStatuses = parseList(
    query.emailOrderStatuses,
    'emailOrderStatuses',
    EMAIL_ORDER_STATUSES
  );
  filters.recipientTags = parseList(query.recipientTags, 'recipientTags');
  filters.productKeys = parseProductKeys(query.productKeys);
  return filters;
}

/** 卡片、候选和所有图表共用的订单条件；权限与业务 TAG 分开相交。 */
function buildDashboardWhere(filters = {}) {
  const where = {};
  const and = [];
  const dates = buildOrderDateCondition({ dateFrom: filters.startDate, dateTo: filters.endDate });
  if (dates) where.orderDate = dates;
  if (filters.status) where.emailOrderStatus = STATUS_MAP[filters.status] || filters.status;
  if (filters.emailOrderStatuses?.length)
    and.push({ emailOrderStatus: { [Op.in]: filters.emailOrderStatuses } });
  if (filters.recipientTags?.length)
    and.push(
      Sequelize.where(Sequelize.literal(RECIPIENT_TAG_SQL), { [Op.in]: filters.recipientTags })
    );
  if (filters.productKeys?.length || filters.productModel) {
    const clauses = [];
    if (filters.productKeys?.length)
      clauses.push(
        productKeySql(
          filters.productKeys,
          '"Order".product_filter_items',
          value => sequelize.escape(value),
          'ordinality - 1'
        )
      );
    if (filters.productModel)
      clauses.push(`item->>'model' = ${sequelize.escape(filters.productModel)}`);
    and.push(
      Sequelize.literal(
        `EXISTS (SELECT 1 FROM jsonb_array_elements("Order".products)
          WITH ORDINALITY AS p(item, ordinality) WHERE ${clauses.join(' AND ')})`
      )
    );
  }
  if (filters.store)
    and.push(
      Sequelize.where(Sequelize.literal('"Order".email_pickup_info->>\'storeName\''), filters.store)
    );
  if (filters.orderUser) {
    const tags = getOrderTagBind(filters.orderUser);
    if (tags !== null) where.tag = { [Op.in]: tags };
  }
  if (and.length) where[Op.and] = and;
  return where;
}

module.exports = { parseDashboardFilters, buildDashboardWhere, RECIPIENT_TAG_SQL };
