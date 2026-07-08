/* eslint-disable camelcase */
/**
 * 统计分析控制器
 * @module controllers/statsController
 * @description overview / 按 Apple ID / 按收件人 / 按产品 4 类统计
 * @see docs/05-API接口设计方案.md 3.4
 */

const { Op, fn, col, literal } = require('sequelize');
const { sequelize, Order, AppleId, Recipient } = require('../models');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'ready_for_pickup', 'completed', 'cancelled'];

const START_OF_TODAY = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const START_OF_THIS_WEEK = () => {
  const d = START_OF_TODAY();
  const day = d.getDay(); // 0 = Sun
  const diff = (day + 6) % 7; // 让周一开始
  d.setDate(d.getDate() - diff);
  return d;
};

const START_OF_THIS_MONTH = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

/**
 * 解析统计接口共用的 date_from / date_to 区间
 */
function parseDateRange(query) {
  const range = {};
  if (query.date_from) {
    const d = new Date(query.date_from);
    if (Number.isNaN(d.getTime())) {
      throw ApiError.badRequest('date_from 不是合法日期', { received: query.date_from });
    }
    range.from = d;
  }
  if (query.date_to) {
    const d = new Date(query.date_to);
    if (Number.isNaN(d.getTime())) {
      throw ApiError.badRequest('date_to 不是合法日期', { received: query.date_to });
    }
    range.to = d;
  }
  if (range.from && range.to && range.from > range.to) {
    throw ApiError.badRequest('date_from 必须早于 date_to', { range });
  }
  return range;
}

/**
 * GET /api/stats/overview
 */
async function getOverview(_req, res) {
  try {
    const totalOrders = await Order.count();
    // 总产品数：聚合求和
    const productSumRow = await Order.findOne({
      attributes: [
        [fn('COALESCE', fn('SUM', literal('jsonb_array_length(products)')), 0), 'totalProducts'],
      ],
      raw: true,
    });
    const totalProducts = parseInt(productSumRow?.get?.('totalProducts') ?? productSumRow?.totalProducts ?? 0, 10);

    // 状态分布
    const statusRows = await Order.findAll({
      attributes: [
        'status',
        [fn('COUNT', col('id')), 'count'],
      ],
      group: ['status'],
      raw: true,
    });
    const statusDistribution = ORDER_STATUSES.reduce((acc, s) => {
      acc[s] = 0;
      return acc;
    }, {});
    statusRows.forEach((r) => {
      statusDistribution[r.status] = parseInt(r.count, 10);
    });

    const todayStart = START_OF_TODAY();
    const weekStart = START_OF_THIS_WEEK();
    const monthStart = START_OF_THIS_MONTH();

    const [todayOrders, weekOrders, monthOrders] = await Promise.all([
      Order.count({ where: { orderDate: { [Op.gte]: todayStart } } }),
      Order.count({ where: { orderDate: { [Op.gte]: weekStart } } }),
      Order.count({ where: { orderDate: { [Op.gte]: monthStart } } }),
    ]);

    res.json({
      success: true,
      data: {
        total_orders: totalOrders,
        total_products: totalProducts,
        status_distribution: statusDistribution,
        today_orders: todayOrders,
        this_week_orders: weekOrders,
        this_month_orders: monthOrders,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('查询总览统计失败', { error: error.message });
    throw ApiError.database('查询总览统计失败', { reason: error.message });
  }
}

/**
 * GET /api/stats/apple-ids
 */
async function getAppleIdStats(_req, res) {
  try {
    const rows = await Order.findAll({
      attributes: [
        'appleIdRef',
        [fn('COUNT', col('Order.id')), 'orderCount'],
        [fn('SUM', literal('COALESCE(jsonb_array_length("Order"."products"), 0)')), 'productCount'],
        [fn('MAX', col('Order.orderDate')), 'latestOrderDate'],
      ],
      include: [{ model: AppleId, as: 'appleAccount', attributes: ['appleId', 'nickname'] }],
      group: ['appleIdRef', 'appleAccount.id'],
      raw: true,
      nest: true,
    });

    res.json({
      success: true,
      data: rows.map((r) => ({
        apple_id_ref: r.appleIdRef,
        apple_id: r.appleAccount?.appleId || null,
        nickname: r.appleAccount?.nickname || null,
        order_count: parseInt(r.orderCount, 10) || 0,
        product_count: parseInt(r.productCount, 10) || 0,
        latest_order_date: r.latestOrderDate,
      })),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('查询 Apple ID 统计失败', { error: error.message });
    throw ApiError.database('查询 Apple ID 统计失败', { reason: error.message });
  }
}

/**
 * GET /api/stats/recipients
 */
async function getRecipientStats(_req, res) {
  try {
    const rows = await Order.findAll({
      attributes: [
        'recipientRef',
        [fn('COUNT', col('Order.id')), 'orderCount'],
        [fn('SUM', literal('COALESCE(jsonb_array_length("Order"."products"), 0)')), 'productCount'],
        [fn('MAX', col('Order.orderDate')), 'latestOrderDate'],
      ],
      include: [
        {
          model: Recipient,
          as: 'recipient',
          attributes: ['id', 'lastName', 'firstName', 'tag'],
        },
      ],
      where: { recipientRef: { [Op.not]: null } },
      group: ['recipientRef', 'recipient.id'],
      raw: true,
      nest: true,
    });

    res.json({
      success: true,
      data: rows.map((r) => ({
        recipient_id: r.recipientRef,
        name: r.recipient
          ? `${r.recipient.lastName || ''}${r.recipient.firstName || ''}`
          : null,
        tag: r.recipient?.tag || null,
        order_count: parseInt(r.orderCount, 10) || 0,
        product_count: parseInt(r.productCount, 10) || 0,
        latest_order_date: r.latestOrderDate,
      })),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('查询收件人统计失败', { error: error.message });
    throw ApiError.database('查询收件人统计失败', { reason: error.message });
  }
}

/**
 * 直接利用 PostgreSQL jsonb_array_elements 聚合产品统计
 * 走原生查询，绕过 Sequelize ORM 对 JSONB 数组元素的限制
 */
const PRODUCT_STATS_SQL = `
  SELECT
    COALESCE(elem->>'name', '') AS name,
    SUM(COALESCE((elem->>'quantity')::int, 0)) AS total_quantity,
    COUNT(DISTINCT "orderId") AS order_count
  FROM "orders" o,
       jsonb_array_elements(o.products) AS elem
  WHERE ($1::timestamp IS NULL OR o.order_date >= $1)
    AND ($2::timestamp IS NULL OR o.order_date <= $2)
    AND elem ? 'name'
  GROUP BY elem->>'name'
  ORDER BY total_quantity DESC
  LIMIT 50
`;

/**
 * 颜色 / 容量分布正则（来自设计文档示例的关键词）
 * 注意：这是 MVP 阶段基于关键词匹配的启发式实现，颜色 / 容量词库有限
 */
const COLOR_KEYWORDS = ['星宇橙色', '鼠尾草绿色', '钛金属', '黑色', '白色', '蓝色', '粉色', '黄色', '午夜色', '星光色'];
const CAPACITY_KEYWORDS = ['1TB', '512GB', '256GB', '128GB', '2TB'];

/**
 * 从产品名称中提取颜色 / 容量关键词
 * @param {string} productName - 产品名
 * @param {string[]} keywords - 词库
 * @returns {string|null} 命中的关键词
 */
function matchKeyword(productName, keywords) {
  if (!productName) return null;
  for (const kw of keywords) {
    if (productName.includes(kw)) return kw;
  }
  return null;
}

/**
 * GET /api/stats/products?date_from=...&date_to=...
 */
async function getProductStats(req, res) {
  try {
    const { from, to } = parseDateRange(req.query);

    const topProducts = await sequelize.query(PRODUCT_STATS_SQL, {
      bind: [from || null, to || null],
      type: sequelize.QueryTypes.SELECT,
    });

    // 颜色 / 容量分布需要原始明细，使用 PostgreSQL jsonb_array_elements 拉平
    const DETAIL_SQL = `
      SELECT elem->>'name' AS name
      FROM "orders" o,
           jsonb_array_elements(o.products) AS elem
      WHERE ($1::timestamp IS NULL OR o.order_date >= $1)
        AND ($2::timestamp IS NULL OR o.order_date <= $2)
        AND elem ? 'name'
    `;

    const detailRows = await sequelize.query(DETAIL_SQL, {
      bind: [from || null, to || null],
      type: sequelize.QueryTypes.SELECT,
    });

    const colorDistribution = {};
    const capacityDistribution = {};
    detailRows.forEach((row) => {
      const name = row.name || '';
      const color = matchKeyword(name, COLOR_KEYWORDS);
      if (color) {
        colorDistribution[color] = (colorDistribution[color] || 0) + 1;
      }
      const capacity = matchKeyword(name, CAPACITY_KEYWORDS);
      if (capacity) {
        capacityDistribution[capacity] = (capacityDistribution[capacity] || 0) + 1;
      }
    });

    res.json({
      success: true,
      data: {
        top_products: topProducts.map((r) => ({
          name: r.name,
          total_quantity: parseInt(r.total_quantity, 10) || 0,
          order_count: parseInt(r.order_count, 10) || 0,
        })),
        color_distribution: colorDistribution,
        capacity_distribution: capacityDistribution,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('查询产品统计失败', { error: error.message });
    throw ApiError.database('查询产品统计失败', { reason: error.message });
  }
}

module.exports = {
  getOverview,
  getAppleIdStats,
  getRecipientStats,
  getProductStats,
};
