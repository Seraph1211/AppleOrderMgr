/**
 * 渠道管理路由
 * @module routes/channels
 * @description 渠道列表、订单明细、渠道名称修改
 */

const express = require('express');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const channelController = require('../controllers/channelController');

const router = express.Router();

/**
 * GET /api/channels
 * 获取渠道列表（动态聚合统计）
 */
router.get('/', requirePermission(PERMISSIONS.CHANNELS_READ), channelController.getChannels);

/**
 * GET /api/channels/:tag/stats
 * 获取渠道详细统计
 */
router.get(
  '/:tag/stats',
  requirePermission(PERMISSIONS.CHANNELS_READ),
  channelController.getChannelStats
);

/**
 * GET /api/channels/:tag/orders
 * 获取渠道订单列表
 */
router.get(
  '/:tag/orders',
  requirePermission(PERMISSIONS.CHANNELS_READ),
  channelController.getChannelOrders
);

/**
 * PUT /api/channels/:tag
 * 修改渠道名称（级联更新）
 */
router.put(
  '/:tag',
  requirePermission(PERMISSIONS.CHANNELS_RENAME),
  channelController.updateChannelName
);

module.exports = router;
