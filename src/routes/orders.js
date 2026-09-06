/**
 * 订单路由
 * @module routes/orders
 * @description 挂载订单相关端点
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const orderController = require('../controllers/orderController');

const router = express.Router();

router.get('/', asyncHandler(orderController.listOrders));
router.get(
  '/export',
  requirePermission(PERMISSIONS.EXPORT),
  asyncHandler(orderController.exportOrders)
);
router.get('/filter-options', asyncHandler(orderController.getFilterOptions));
router.get('/:id', asyncHandler(orderController.getOrderDetail));
router.put('/:id', requirePermission(PERMISSIONS.WRITE), asyncHandler(orderController.updateOrder));
router.post(
  '/:id/refresh',
  requirePermission(PERMISSIONS.REFRESH),
  asyncHandler(orderController.refreshOrder)
);
router.post(
  '/batch-refresh',
  requirePermission(PERMISSIONS.REFRESH),
  asyncHandler(orderController.batchRefresh)
);

module.exports = router;
