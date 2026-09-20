/**
 * 订单路由
 * @module routes/orders
 * @description 挂载订单相关端点
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission, requireRole } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const orderController = require('../controllers/orderController');
const payerController = require('../controllers/payerController');
const browserRefreshController = require('../controllers/browserRefreshController');
const orderMailLifecycleController = require('../controllers/orderMailLifecycleController');

const router = express.Router();

router.use('/:id/emails', require('./orderMail'));

router.post(
  '/email-lifecycle/replay',
  requirePermission(PERMISSIONS.ORDER_MAIL_MANAGE),
  asyncHandler(orderMailLifecycleController.replayOrders)
);
router.post(
  '/:id/email-lifecycle/replay',
  requirePermission(PERMISSIONS.ORDER_MAIL_MANAGE),
  asyncHandler(orderMailLifecycleController.replayOrder)
);

router.post(
  '/:id/browser-refresh/start',
  requireRole(['admin']),
  requirePermission(PERMISSIONS.ORDERS_REFRESH),
  asyncHandler(browserRefreshController.startBrowserRefresh)
);
router.post(
  '/:id/browser-refresh/permit',
  requireRole(['admin']),
  requirePermission(PERMISSIONS.ORDERS_REFRESH),
  asyncHandler(browserRefreshController.permitBrowserRequest)
);
router.post(
  '/:id/browser-refresh/result',
  requireRole(['admin']),
  requirePermission(PERMISSIONS.ORDERS_REFRESH),
  asyncHandler(browserRefreshController.completeBrowserRefresh)
);

router.get(
  '/',
  requirePermission(PERMISSIONS.ORDERS_READ),
  asyncHandler(orderController.listOrders)
);
router.get(
  '/export',
  requirePermission(PERMISSIONS.ORDERS_EXPORT),
  asyncHandler(orderController.exportOrders)
);
router.get(
  '/filter-options',
  requirePermission(PERMISSIONS.ORDERS_READ),
  asyncHandler(orderController.getFilterOptions)
);
router.post(
  '/refresh-all',
  requirePermission(PERMISSIONS.ORDERS_REFRESH),
  asyncHandler(orderController.refreshAll)
);
router.post(
  '/page-open-refresh',
  requirePermission(PERMISSIONS.ORDERS_REFRESH),
  asyncHandler(orderController.pageOpenRefresh)
);
router.post(
  '/batch-refresh',
  requirePermission(PERMISSIONS.ORDERS_REFRESH),
  asyncHandler(orderController.batchRefresh)
);
router.get(
  '/:id/link',
  requirePermission(PERMISSIONS.ORDERS_READ),
  asyncHandler(orderController.getOrderLink)
);
router.get(
  '/:id',
  requirePermission(PERMISSIONS.ORDERS_READ),
  asyncHandler(orderController.getOrderDetail)
);
router.put(
  '/:id',
  requirePermission(PERMISSIONS.ORDERS_EDIT),
  asyncHandler(orderController.updateOrder)
);
router.post(
  '/:id/refresh',
  requirePermission(PERMISSIONS.ORDERS_REFRESH),
  asyncHandler(orderController.refreshOrder)
);
router.put(
  '/:id/payer',
  requirePermission(PERMISSIONS.ORDERS_PAYER_EDIT),
  asyncHandler(payerController.assignOrderPayer)
);

module.exports = router;
