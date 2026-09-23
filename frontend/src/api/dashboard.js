import client from './client';

function queryParams(filters = {}) {
  const params = { ...filters };
  for (const key of ['emailOrderStatuses', 'productKeys', 'recipientTags']) {
    if (Array.isArray(params[key])) params[key] = JSON.stringify(params[key]);
  }
  return params;
}

/** 获取仪表板汇总，支持北京时间日期及邮件状态、商品、TAG 多选。 */
export const getDashboardStats = (params = {}) =>
  client.get('/dashboard/stats', { params: queryParams(params) });
/** 获取按下单日期统计的订单趋势。 */
export const getDailyOrderTrend = (params = {}) =>
  client.get('/dashboard/daily-trend', { params: queryParams(params) });
/** 获取完整商品规格的订单数分布。 */
export const getProductModelDistribution = (params = {}) =>
  client.get('/dashboard/product-distribution', { params: queryParams(params) });
/** 获取取货门店所在城市的订单数分布。 */
export const getCityDistribution = (params = {}) =>
  client.get('/dashboard/city-distribution', { params: queryParams(params) });
/** 兼容旧门店分布调用。 */
export const getStoreDistribution = (params = {}) =>
  client.get('/dashboard/store-distribution', { params: queryParams(params) });
/** 获取当前权限和其他筛选条件内的商品、TAG 候选。 */
export const getFilterOptions = (params = {}) =>
  client.get('/dashboard/filter-options', { params: queryParams(params) });
