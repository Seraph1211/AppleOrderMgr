import client from './client';

/**
 * 获取仪表板统计数据
 * @param {Object} params - 筛选参数
 * @param {string} params.startDate - 开始日期 (YYYY-MM-DD)
 * @param {string} params.endDate - 结束日期 (YYYY-MM-DD)
 * @param {string} params.status - 订单状态
 * @param {string} params.productModel - 产品型号
 * @param {string} params.store - 取机门店
 * @returns {Promise<Object>} 仪表板数据
 */
export const getDashboardStats = (params = {}) => {
  return client.get('/dashboard/stats', { params });
};

/**
 * 获取每日订单趋势
 * @param {Object} params - 筛选参数
 * @returns {Promise<Array>} 每日订单数据
 */
export const getDailyOrderTrend = (params = {}) => {
  return client.get('/dashboard/daily-trend', { params });
};

/**
 * 获取产品型号分布
 * @param {Object} params - 筛选参数
 * @returns {Promise<Array>} 产品型号分布数据
 */
export const getProductModelDistribution = (params = {}) => {
  return client.get('/dashboard/product-distribution', { params });
};

/**
 * 获取取货门店分布
 * @param {Object} params - 筛选参数
 * @returns {Promise<Array>} 门店分布数据
 */
export const getStoreDistribution = (params = {}) => {
  return client.get('/dashboard/store-distribution', { params });
};

/**
 * 获取筛选器选项（产品型号、门店列表）
 * @returns {Promise<Object>} 筛选器选项数据
 */
export const getFilterOptions = () => {
  return client.get('/dashboard/filter-options');
};
