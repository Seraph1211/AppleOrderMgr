/**
 * 订单路由
 * @module routes/orders
 * @description 挂载订单相关端点
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const orderController = require('../controllers/orderController');

const router = express.Router();

router.get('/', asyncHandler(orderController.listOrders));
router.get('/:id', asyncHandler(orderController.getOrderDetail));
router.post('/:id/refresh', asyncHandler(orderController.refreshOrder));
router.post('/batch-refresh', asyncHandler(orderController.batchRefresh));

module.exports = router;
