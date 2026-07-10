const logger = require('../utils/logger');
const dashboardService = require('../services/dashboardService');

/**
 * 获取仪表板统计数据
 * @route GET /api/dashboard/stats
 */
const getStats = async (req, res) => {
  try {
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      status: req.query.status,
      productModel: req.query.productModel,
      store: req.query.store
    };

    const stats = await dashboardService.getStats(filters);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('获取仪表板统计数据失败', {
      error: error.message,
      stack: error.stack,
      query: req.query
    });
    res.status(500).json({
      success: false,
      message: '获取统计数据失败',
      error: error.message
    });
  }
};

/**
 * 获取每日订单趋势
 * @route GET /api/dashboard/daily-trend
 */
const getDailyTrend = async (req, res) => {
  try {
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      status: req.query.status,
      productModel: req.query.productModel,
      store: req.query.store
    };

    const trend = await dashboardService.getDailyTrend(filters);

    res.json({
      success: true,
      data: trend
    });
  } catch (error) {
    logger.error('获取每日订单趋势失败', {
      error: error.message,
      stack: error.stack,
      query: req.query
    });
    res.status(500).json({
      success: false,
      message: '获取趋势数据失败',
      error: error.message
    });
  }
};

/**
 * 获取产品型号分布
 * @route GET /api/dashboard/product-distribution
 */
const getProductDistribution = async (req, res) => {
  try {
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      status: req.query.status,
      store: req.query.store
    };

    const distribution = await dashboardService.getProductDistribution(filters);

    res.json({
      success: true,
      data: distribution
    });
  } catch (error) {
    logger.error('获取产品型号分布失败', {
      error: error.message,
      stack: error.stack,
      query: req.query
    });
    res.status(500).json({
      success: false,
      message: '获取产品分布数据失败',
      error: error.message
    });
  }
};

/**
 * 获取取货门店分布
 * @route GET /api/dashboard/store-distribution
 */
const getStoreDistribution = async (req, res) => {
  try {
    const filters = {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      status: req.query.status,
      productModel: req.query.productModel
    };

    const distribution = await dashboardService.getStoreDistribution(filters);

    res.json({
      success: true,
      data: distribution
    });
  } catch (error) {
    logger.error('获取取货门店分布失败', {
      error: error.message,
      stack: error.stack,
      query: req.query
    });
    res.status(500).json({
      success: false,
      message: '获取门店分布数据失败',
      error: error.message
    });
  }
};

/**
 * 获取筛选器选项
 * @route GET /api/dashboard/filter-options
 */
const getFilterOptions = async (req, res) => {
  try {
    const options = await dashboardService.getFilterOptions();

    res.json({
      success: true,
      data: options
    });
  } catch (error) {
    logger.error('获取筛选器选项失败', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      message: '获取筛选器选项失败',
      error: error.message
    });
  }
};

module.exports = {
  getStats,
  getDailyTrend,
  getProductDistribution,
  getStoreDistribution,
  getFilterOptions
};
