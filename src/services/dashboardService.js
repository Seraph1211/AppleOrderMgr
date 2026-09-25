const { Op, fn, col, literal } = require('sequelize');
const { Order, Recipient, PickupStore } = require('../models');
const { buildDashboardWhere, RECIPIENT_TAG_SQL } = require('./dashboardFilters');
const { collectProductOptions } = require('../utils/productFilter');
const { parseOrderTimeBoundary } = require('../utils/orderTime');
const logger = require('../utils/logger');

const MAX_FILL_DAYS = 3660;
const ISO_DATE_LENGTH = 10;
const DAY_MS = 86400000;
const PERCENT = 100;
const PRODUCT_ATTRIBUTES = ['products', 'productFilterItems', 'sourceSnapshot'];
const growth = (current, previous) =>
  previous ? ((current - previous) / previous) * PERCENT : current ? PERCENT : 0;

/** 获取订单指标；可用取机人仅按档案 TAG 及可用状态筛选。 */
async function getStats(filters = {}) {
  try {
    const where = buildDashboardWhere(filters);
    const recipientWhere = { status: { [Op.in]: ['使用中', '未使用'] } };
    if (filters.recipientTags?.length) recipientWhere.tag = { [Op.in]: filters.recipientTags };
    const [
      totalOrders,
      paidOrders,
      pendingOrders,
      availableRecipients,
      amount,
      missingAmountOrders,
    ] = await Promise.all([
      Order.count({ where }),
      Order.count({
        where: {
          [Op.and]: [
            where,
            {
              emailOrderStatus: {
                [Op.in]: ['processing', 'ready_for_pickup', 'picked_up'],
              },
            },
          ],
        },
      }),
      Order.count({
        where: {
          [Op.and]: [
            where,
            { emailOrderStatus: { [Op.in]: ['unknown', 'confirmed', 'processing'] } },
          ],
        },
      }),
      Recipient.count({ where: recipientWhere }),
      Order.sum('orderAmount', { where }),
      Order.count({ where: { ...where, orderAmount: null } }),
    ]);
    const totalAmount = Number(amount || 0);
    let orderGrowth = null;
    let amountGrowth = null;
    if (filters.startDate && filters.endDate) {
      const start = parseOrderTimeBoundary(filters.startDate);
      const end = parseOrderTimeBoundary(filters.endDate, true);
      const duration = end - start + 1;
      const previousWhere = {
        ...where,
        orderDate: {
          [Op.gte]: new Date(start.getTime() - duration),
          [Op.lte]: new Date(start.getTime() - 1),
        },
      };
      const [previousOrders, previousAmount] = await Promise.all([
        Order.count({ where: previousWhere }),
        Order.sum('orderAmount', { where: previousWhere }),
      ]);
      orderGrowth = growth(totalOrders, previousOrders);
      amountGrowth = growth(totalAmount, Number(previousAmount || 0));
    }
    return {
      totalOrders,
      paidOrders,
      pendingOrders,
      availableRecipients,
      totalAmount,
      amountSource: 'catalog',
      missingAmountOrders,
      orderGrowth,
      amountGrowth,
    };
  } catch (error) {
    logger.error('获取仪表板统计失败', { error: error.message });
    throw error;
  }
}

/** 按北京时间下单日聚合并补齐所选范围内的空日期。 */
async function getDailyTrend(filters = {}) {
  try {
    const dateExpression = literal("DATE(order_date AT TIME ZONE 'Asia/Shanghai')");
    const rows = await Order.findAll({
      attributes: [
        [dateExpression, 'date'],
        [fn('COUNT', col('id')), 'count'],
      ],
      where: buildDashboardWhere(filters),
      group: [dateExpression],
      order: [[dateExpression, 'ASC']],
      raw: true,
    });
    const counts = new Map(rows.filter(row => row.date).map(row => [row.date, Number(row.count)]));
    const dates = [...counts.keys()];
    // 未指定任一边界时以实际订单范围补齐，最多补 3660 天，避免恶意宽范围耗尽内存。
    const start = filters.startDate || dates[0];
    const end = filters.endDate || dates[dates.length - 1];
    if (start && end && (new Date(end) - new Date(start)) / DAY_MS <= MAX_FILL_DAYS) {
      for (
        let day = new Date(start);
        day <= new Date(end);
        day = new Date(day.getTime() + DAY_MS)
      ) {
        const key = day.toISOString().slice(0, ISO_DATE_LENGTH);
        if (!counts.has(key)) counts.set(key, 0);
      }
    }
    return [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  } catch (error) {
    logger.error('获取仪表板趋势失败', { error: error.message });
    throw error;
  }
}

/** 按完整商品身份统计，每个订单每种商品最多计一次。 */
async function getProductDistribution(filters = {}) {
  try {
    const rows = await Order.findAll({
      attributes: PRODUCT_ATTRIBUTES,
      where: buildDashboardWhere(filters),
      raw: true,
    });
    const result = collectProductOptions(rows).map(item => ({
      key: item.value,
      name: item.label.split(' · ')[0],
      value: item.count,
    }));
    const unknown = rows.filter(row => !row.products?.length).length;
    if (unknown) result.push({ key: 'unknown', name: '未知商品', value: unknown });
    return result.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'zh-CN'));
  } catch (error) {
    logger.error('获取商品分布失败', { error: error.message });
    throw error;
  }
}

function normalizeStoreName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/^Apple\s*[,，]?\s*/i, '')
    .replace(/[›>]+$/g, '')
    .replace(/\s+/g, '');
}

/** 门店城市只从已核对字典获取，邮件门店优先；未知和歧义值不猜测。 */
async function getCityDistribution(filters = {}) {
  try {
    const storeExpression = literal("email_pickup_info->>'storeName'");
    const [rows, stores] = await Promise.all([
      Order.findAll({
        attributes: [
          [storeExpression, 'emailStore'],
          'pickupStoreCode',
          'pickupStore',
          [fn('COUNT', col('id')), 'value'],
        ],
        where: buildDashboardWhere(filters),
        group: [storeExpression, 'pickupStoreCode', 'pickupStore'],
        raw: true,
      }),
      PickupStore.findAll({ attributes: ['code', 'name', 'city'], raw: true }),
    ]);
    const byCode = new Map(stores.map(store => [store.code, store.city]));
    const byName = new Map();
    for (const store of stores) {
      const key = normalizeStoreName(store.name);
      const cities = byName.get(key) || new Set();
      if (store.city) cities.add(store.city.replace(/市$/, ''));
      byName.set(key, cities);
    }
    const nameCity = name => {
      const cities = byName.get(normalizeStoreName(name));
      return cities?.size === 1 ? [...cities][0] : null;
    };
    const counts = new Map();
    for (const row of rows) {
      const city =
        (row.emailStore?.trim()
          ? nameCity(row.emailStore)
          : byCode.get(row.pickupStoreCode) || nameCity(row.pickupStore)) || '未知城市';
      const name = city === '未知城市' ? city : city.replace(/市$/, '');
      counts.set(name, (counts.get(name) || 0) + Number(row.value));
    }
    return [...counts]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'zh-CN'));
  } catch (error) {
    logger.error('获取城市分布失败', { error: error.message });
    throw error;
  }
}

/** 保留旧门店分布契约，并应用全部订单筛选。 */
async function getStoreDistribution(filters = {}) {
  try {
    const expression = literal("email_pickup_info->>'storeName'");
    const rows = await Order.findAll({
      attributes: [
        [expression, 'name'],
        [fn('COUNT', col('id')), 'value'],
      ],
      where: buildDashboardWhere(filters),
      group: [expression],
      order: [[fn('COUNT', col('id')), 'DESC']],
      raw: true,
    });
    return rows.map(row => ({ name: row.name || '未知门店', value: Number(row.value) }));
  } catch (error) {
    logger.error('获取门店分布失败', { error: error.message });
    throw error;
  }
}

/** 从完整权限范围获取候选，不受分页截断；分别排除本维度筛选。 */
async function getFilterOptions(filters = {}) {
  try {
    const storeExpression = literal("email_pickup_info->>'storeName'");
    const tagExpression = literal(RECIPIENT_TAG_SQL);
    const [products, tags, stores] = await Promise.all([
      Order.findAll({
        attributes: PRODUCT_ATTRIBUTES,
        where: buildDashboardWhere({ ...filters, productKeys: [], productModel: '' }),
        raw: true,
      }),
      Order.findAll({
        attributes: [[tagExpression, 'recipientTag']],
        where: buildDashboardWhere({ ...filters, recipientTags: [] }),
        group: [tagExpression],
        raw: true,
      }),
      Order.findAll({
        attributes: [[storeExpression, 'store']],
        where: buildDashboardWhere({ ...filters, store: '' }),
        group: [storeExpression],
        raw: true,
      }),
    ]);
    return {
      productOptions: collectProductOptions(products),
      recipientTags: tags
        .map(item => item.recipientTag)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'zh-CN')),
      productModels: [
        ...new Set(
          products.flatMap(row => (row.products || []).map(item => item.model)).filter(Boolean)
        ),
      ].sort(),
      stores: stores
        .map(item => item.store)
        .filter(Boolean)
        .sort(),
    };
  } catch (error) {
    logger.error('获取仪表板候选失败', { error: error.message });
    throw error;
  }
}

module.exports = {
  getStats,
  getDailyTrend,
  getProductDistribution,
  getCityDistribution,
  getStoreDistribution,
  getFilterOptions,
};
