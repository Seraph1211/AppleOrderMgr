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
const payerController = require('../controllers/payerController');
const orderMailLifecycleController = require('../controllers/orderMailLifecycleController');
const retiredFeature = require('../middleware/retiredFeature');

const router = express.Router();
const devices = require('../controllers/pickupDeviceController');
const orderSerial = require('../controllers/orderSerialController');
router.delete('/:orderId/devices/:deviceId', requirePermission(PERMISSIONS.ORDERS_READ), requirePermission(PERMISSIONS.ORDERS_EDIT), asyncHandler(orderSerial.remove));
router.get(
  '/:orderId/devices',
  requirePermission(PERMISSIONS.ORDERS_READ),
  asyncHandler(devices.list)
);
router.post(
  '/:orderId/devices',
  requirePermission(PERMISSIONS.ORDERS_READ),
  requirePermission(PERMISSIONS.ORDERS_EDIT),
  asyncHandler(devices.create)
);
router.put(
  '/:orderId/devices/:deviceId',
  requirePermission(PERMISSIONS.ORDERS_READ),
  requirePermission(PERMISSIONS.ORDERS_EDIT),
  asyncHandler(orderSerial.update)
);



router.use('/official-refresh', require('./officialOrderRefresh'));

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

router.post('/:id/browser-refresh/start', retiredFeature('浏览器官网采集'));
router.post('/:id/browser-refresh/permit', retiredFeature('浏览器官网采集'));
router.post('/:id/browser-refresh/result', retiredFeature('浏览器官网采集'));

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
router.post('/refresh-all', retiredFeature('官网订单刷新'));
router.post('/page-open-refresh', retiredFeature('官网订单刷新'));
router.post('/batch-refresh', retiredFeature('官网订单刷新'));
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
router.post('/:id/refresh', retiredFeature('官网订单刷新'));
router.put(
  '/:id/payer',
  requirePermission(PERMISSIONS.ORDERS_PAYER_EDIT),
  asyncHandler(payerController.assignOrderPayer)
);

module.exports = router;
