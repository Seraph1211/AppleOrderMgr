/**
 * 渠道管理路由
 * @module routes/channels
 * @description 渠道列表、订单明细、渠道名称修改
 */

const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const channelController = require('../controllers/channelController');

const router = express.Router();

// 所有接口都需要认证
router.use(authenticate);

/**
 * GET /api/channels
 * 获取渠道列表（动态聚合统计）
 */
router.get('/', channelController.getChannels);

/**
 * GET /api/channels/:tag/stats
 * 获取渠道详细统计
 */
router.get('/:tag/stats', channelController.getChannelStats);

/**
 * GET /api/channels/:tag/orders
 * 获取渠道订单列表
 */
router.get('/:tag/orders', channelController.getChannelOrders);

/**
 * PUT /api/channels/:tag
 * 修改渠道名称（级联更新）
 */
router.put('/:tag', channelController.updateChannelName);

module.exports = router;
