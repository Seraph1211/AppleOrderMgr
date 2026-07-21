const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authMiddleware');
const dashboardController = require('../controllers/dashboardController');

// 所有接口都需要认证
router.use(authenticate);

/**
 * @route GET /api/dashboard/stats
 * @desc 获取仪表板统计数据
 * @access Public
 */
router.get('/stats', dashboardController.getStats);

/**
 * @route GET /api/dashboard/daily-trend
 * @desc 获取每日订单趋势
 * @access Public
 */
router.get('/daily-trend', dashboardController.getDailyTrend);

/**
 * @route GET /api/dashboard/product-distribution
 * @desc 获取产品型号分布
 * @access Public
 */
router.get('/product-distribution', dashboardController.getProductDistribution);

/**
 * @route GET /api/dashboard/store-distribution
 * @desc 获取取货门店分布
 * @access Public
 */
router.get('/store-distribution', dashboardController.getStoreDistribution);

/**
 * @route GET /api/dashboard/filter-options
 * @desc 获取筛选器选项（产品型号、门店列表）
 * @access Public
 */
router.get('/filter-options', dashboardController.getFilterOptions);

module.exports = router;
