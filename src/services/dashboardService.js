/* eslint-disable no-unused-vars, require-await, camelcase */
const { Op, fn, col, literal } = require('sequelize');
const { Order, AppleId, Recipient, sequelize } = require('../models');
const logger = require('../utils/logger');

/**
 * 构建订单查询条件
 * @param {Object} filters - 筛选参数
 * @returns {Object} Sequelize where 条件
 */
const buildWhereClause = (filters) => {
  const where = {};

  // 日期范围
  if (filters.startDate || filters.endDate) {
    where.orderDate = {};
    if (filters.startDate) {
      where.orderDate[Op.gte] = new Date(filters.startDate);
    }
    if (filters.endDate) {
      const endDate = new Date(filters.endDate);
      endDate.setHours(23, 59, 59, 999);
      where.orderDate[Op.lte] = endDate;
    }
  }

  // 订单状态（转换中文为英文）
  if (filters.status) {
    const englishStatus = STATUS_MAP[filters.status] || filters.status;
    where.status = englishStatus;
  }

  // 产品型号（需要在 JSONB products 数组中搜索）
  if (filters.productModel) {
    where[Op.and] = literal(
      `EXISTS (
        SELECT 1 FROM jsonb_array_elements(products) AS product
        WHERE product->>'model' = '${filters.productModel.replace(/'/g, '\'\'')}'
      )`
    );
  }

  // 取货门店
  if (filters.store) {
    where.pickupStore = filters.store;
  }

  return where;
};

/**
 * 状态映射（中文 -> 英文）
 */
const STATUS_MAP = {
  '待处理': 'pending',
  '处理中': 'processing',
  '已发货': 'shipped',
  '可取货': 'ready_for_pickup',
  '已完成': 'completed',
  '已取消': 'cancelled'
};

/**
 * 获取仪表板统计数据
 * @param {Object} filters - 筛选参数
 * @returns {Promise<Object>} 统计数据
 */
const getStats = async (filters) => {
  try {
    const where = buildWhereClause(filters);

    // 获取当前周期统计
    const [totalOrders, pendingOrders, activeRecipients] = await Promise.all([
      // 总订单量
      Order.count({ where }),

      // 待取订单数（待处理、处理中、可取货）
      Order.count({
        where: {
          ...where,
          status: { [Op.in]: ['pending', 'processing', 'ready_for_pickup'] }
        }
      }),

      // 活跃收件人数（有订单的收件人）
      Order.count({
        where,
        distinct: true,
        col: 'recipient_ref'
      })
    ]);

    // 计算订单总额（从 products JSONB 中动态计算）
    const totalAmount = await calculateTotalAmount(where);
    const previousAmount = await calculateTotalAmount(buildPreviousPeriodWhere(filters));

    // 计算增长率（与上一周期对比）
    const previousWhere = buildPreviousPeriodWhere(filters);
    const previousOrders = await Order.count({ where: previousWhere });

    const orderGrowth = calculateGrowth(totalOrders, previousOrders);
    const amountGrowth = calculateGrowth(totalAmount, previousAmount);

    return {
      totalOrders: totalOrders || 0,
      totalAmount: totalAmount || 0,
      pendingOrders: pendingOrders || 0,
      activeRecipients: activeRecipients || 0,
      orderGrowth,
      amountGrowth
    };
  } catch (error) {
    logger.error('获取仪表板统计数据失败', {
      error: error.message,
      stack: error.stack,
      filters
    });
    throw error;
  }
};

/**
 * 计算订单总额（从 products JSONB 中提取价格并累加）
 * @param {Object} where - 查询条件
 * @returns {Promise<number>} 订单总额
 */
const calculateTotalAmount = async (where) => {
  try {
    // 从 products JSONB 中提取价格并求和
    // 注意：这里假设 products 数组中每个产品有 price 和 quantity 字段
    const result = await sequelize.query(
      `
      SELECT COALESCE(SUM(
        (product->>'price')::numeric * (product->>'quantity')::integer
      ), 0) AS total
      FROM orders, jsonb_array_elements(products) AS product
      WHERE ${buildSqlWhereClauseForAmount(where)}
        AND product->>'price' IS NOT NULL
        AND product->>'quantity' IS NOT NULL
      `,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: getReplacementsFromWhere(where)
      }
    );

    return parseFloat(result[0]?.total || 0);
  } catch (error) {
    logger.error('计算订单总额失败', {
      error: error.message,
      where
    });
    return 0;
  }
};

/**
 * 构建上一周期的查询条件
 * @param {Object} filters - 当前筛选参数
 * @returns {Object} 上一周期的 where 条件
 */
const buildPreviousPeriodWhere = (filters) => {
  const where = { ...buildWhereClause(filters) };

  if (filters.startDate && filters.endDate) {
    const start = new Date(filters.startDate);
    const end = new Date(filters.endDate);
    const duration = end - start;

    const previousStart = new Date(start.getTime() - duration);
    const previousEnd = new Date(start.getTime() - 1);

    where.orderDate = {
      [Op.gte]: previousStart,
      [Op.lte]: previousEnd
    };
  }

  return where;
};

/**
 * 计算增长率
 * @param {number} current - 当前值
 * @param {number} previous - 之前值
 * @returns {number} 增长率百分比
 */
const calculateGrowth = (current, previous) => {
  if (!previous || previous === 0) {
    return current > 0 ? 100 : 0;
  }
  return ((current - previous) / previous) * 100;
};

/**
 * 获取每日订单趋势
 * @param {Object} filters - 筛选参数
 * @returns {Promise<Array>} 每日订单数据
 */
const getDailyTrend = async (filters) => {
  try {
    const where = buildWhereClause(filters);

    // 按日期分组统计订单数量（使用数据库字段名 order_date）
    const dailyData = await sequelize.query(
      `
      SELECT
        DATE(order_date) AS date,
        COUNT(*) AS count
      FROM orders
      WHERE ${buildSqlWhereClauseForAmount(where)}
      GROUP BY DATE(order_date)
      ORDER BY DATE(order_date) ASC
      `,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: getReplacementsFromWhere(where)
      }
    );

    // 填充缺失日期（确保每天都有数据）
    const filledData = fillMissingDates(
      dailyData,
      filters.startDate,
      filters.endDate
    );

    return filledData.map(item => ({
      date: formatDate(item.date),
      count: parseInt(item.count) || 0
    }));
  } catch (error) {
    logger.error('获取每日订单趋势失败', {
      error: error.message,
      stack: error.stack,
      filters
    });
    throw error;
  }
};

/**
 * 填充缺失的日期
 * @param {Array} data - 现有数据
 * @param {string} startDate - 开始日期
 * @param {string} endDate - 结束日期
 * @returns {Array} 填充后的数据
 */
const fillMissingDates = (data, startDate, endDate) => {
  if (!startDate || !endDate) {
    return data;
  }

  const dataMap = new Map(data.map(item => [item.date, item]));
  const result = [];

  let current = new Date(startDate);
  const end = new Date(endDate);

  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    result.push(
      dataMap.get(dateStr) || { date: dateStr, count: 0 }
    );
    current.setDate(current.getDate() + 1);
  }

  return result;
};

/**
 * 格式化日期为中文
 * @param {string} dateStr - ISO 日期字符串
 * @returns {string} 格式化后的日期
 */
const formatDate = (dateStr) => {
  const date = new Date(dateStr);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = weekdays[date.getDay()];
  return `${month}月${day}日`;
};

/**
 * 获取产品型号分布
 * @param {Object} filters - 筛选参数
 * @returns {Promise<Array>} 产品型号分布数据
 */
const getProductDistribution = async (filters) => {
  try {
    const where = buildWhereClause(filters);

    // 从 JSONB 数组中提取产品型号并统计
    const result = await sequelize.query(
      `
      SELECT
        product->>'model' AS name,
        COUNT(*) AS value
      FROM
        orders,
        jsonb_array_elements(products) AS product
      WHERE
        ${buildSqlWhereClause(filters)}
      GROUP BY
        product->>'model'
      ORDER BY
        value DESC
      LIMIT 10
      `,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: getReplacements(filters)
      }
    );

    return result.map(item => ({
      name: item.name || '未知型号',
      value: parseInt(item.value)
    }));
  } catch (error) {
    logger.error('获取产品型号分布失败', {
      error: error.message,
      stack: error.stack,
      filters
    });
    throw error;
  }
};

/**
 * 获取取货门店分布
 * @param {Object} filters - 筛选参数
 * @returns {Promise<Array>} 门店分布数据
 */
const getStoreDistribution = async (filters) => {
  try {
    const where = buildWhereClause(filters);

    const result = await Order.findAll({
      attributes: [
        'pickupStore',
        [fn('COUNT', col('id')), 'value']
      ],
      where: {
        ...where,
        pickupStore: { [Op.ne]: null }
      },
      group: ['pickupStore'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      limit: 10,
      raw: true
    });

    return result.map(item => ({
      name: item.pickupStore || '未知门店',
      value: parseInt(item.value)
    }));
  } catch (error) {
    logger.error('获取取货门店分布失败', {
      error: error.message,
      stack: error.stack,
      filters
    });
    throw error;
  }
};

/**
 * 构建 SQL WHERE 子句
 * @param {Object} filters - 筛选参数
 * @returns {string} SQL WHERE 子句
 */
const buildSqlWhereClause = (filters) => {
  const conditions = ['1=1']; // 默认条件

  if (filters.startDate) {
    conditions.push('order_date >= :startDate');
  }
  if (filters.endDate) {
    conditions.push('order_date <= :endDate');
  }
  if (filters.status) {
    const englishStatus = STATUS_MAP[filters.status] || filters.status;
    conditions.push('status = :status');
  }
  if (filters.store) {
    conditions.push('pickup_store = :store');
  }

  return conditions.join(' AND ');
};

/**
 * 构建用于金额计算的 SQL WHERE 子句
 * @param {Object} where - Sequelize where 对象
 * @returns {string} SQL WHERE 子句
 */
const buildSqlWhereClauseForAmount = (where) => {
  const conditions = ['1=1'];

  if (where.orderDate) {
    if (where.orderDate[Op.gte]) {
      conditions.push('order_date >= :startDate');
    }
    if (where.orderDate[Op.lte]) {
      conditions.push('order_date <= :endDate');
    }
  }
  if (where.status) {
    conditions.push('status = :status');
  }
  if (where.pickupStore) {
    conditions.push('pickup_store = :store');
  }

  return conditions.join(' AND ');
};

/**
 * 从 where 对象提取 SQL 参数
 * @param {Object} where - Sequelize where 对象
 * @returns {Object} 参数对象
 */
const getReplacementsFromWhere = (where) => {
  const replacements = {};

  if (where.orderDate) {
    if (where.orderDate[Op.gte]) {
      replacements.startDate = where.orderDate[Op.gte];
    }
    if (where.orderDate[Op.lte]) {
      replacements.endDate = where.orderDate[Op.lte];
    }
  }
  if (where.status) {
    replacements.status = where.status;
  }
  if (where.pickupStore) {
    replacements.store = where.pickupStore;
  }

  return replacements;
};

/**
 * 获取 SQL 参数替换
 * @param {Object} filters - 筛选参数
 * @returns {Object} 参数对象
 */
const getReplacements = (filters) => {
  const replacements = {};

  if (filters.startDate) {
    replacements.startDate = filters.startDate;
  }
  if (filters.endDate) {
    const endDate = new Date(filters.endDate);
    endDate.setHours(23, 59, 59, 999);
    replacements.endDate = endDate;
  }
  if (filters.status) {
    const englishStatus = STATUS_MAP[filters.status] || filters.status;
    replacements.status = englishStatus;
  }
  if (filters.store) {
    replacements.store = filters.store;
  }

  return replacements;
};

/**
 * 获取筛选器选项
 * @returns {Promise<Object>} 筛选器选项数据
 */
const getFilterOptions = async () => {
  try {
    // 获取所有产品型号（从 JSONB 中提取）
    const productModels = await sequelize.query(
      `
      SELECT DISTINCT product->>'model' AS model
      FROM orders, jsonb_array_elements(products) AS product
      WHERE product->>'model' IS NOT NULL
      ORDER BY model
      `,
      { type: sequelize.QueryTypes.SELECT }
    );

    // 获取所有取货门店（使用数据库字段名 pickup_store）
    const stores = await sequelize.query(
      `
      SELECT DISTINCT pickup_store AS store
      FROM orders
      WHERE pickup_store IS NOT NULL
      ORDER BY pickup_store
      `,
      { type: sequelize.QueryTypes.SELECT }
    );

    return {
      productModels: productModels.map(item => item.model).filter(Boolean),
      stores: stores.map(item => item.store).filter(Boolean)
    };
  } catch (error) {
    logger.error('获取筛选器选项失败', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
};

module.exports = {
  getStats,
  getDailyTrend,
  getProductDistribution,
  getStoreDistribution,
  getFilterOptions
};
