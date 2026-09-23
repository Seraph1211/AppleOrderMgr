const logger = require('../utils/logger');
const dashboardService = require('../services/dashboardService');
const { parseDashboardFilters } = require('../services/dashboardFilters');

const BAD_REQUEST = 400;
const INTERNAL_ERROR = 500;

/** 所有图表共用参数校验、服务端权限注入和错误返回。 */
function handler(method) {
  return async (req, res) => {
    try {
      const filters = parseDashboardFilters(req.query, req.user);
      const data = await dashboardService[method](filters);
      res.json({ success: true, data });
    } catch (error) {
      const status = error.statusCode || INTERNAL_ERROR;
      logger.error('仪表板请求失败', { method, status, error: error.message });
      res.status(status).json({
        success: false,
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: status === BAD_REQUEST ? error.message : '加载仪表板数据失败，请重试',
        },
      });
    }
  };
}

module.exports = {
  getStats: handler('getStats'),
  getDailyTrend: handler('getDailyTrend'),
  getProductDistribution: handler('getProductDistribution'),
  getCityDistribution: handler('getCityDistribution'),
  getStoreDistribution: handler('getStoreDistribution'),
  getFilterOptions: handler('getFilterOptions'),
};
