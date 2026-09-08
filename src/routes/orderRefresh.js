const express = require('express');

const orderRefreshController = require('../controllers/orderRefreshController');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');

const router = express.Router();

router.get(
  '/jobs/:id',
  requirePermission(PERMISSIONS.ORDERS_REFRESH),
  asyncHandler(orderRefreshController.getJob)
);
router.get(
  '/batches/:id',
  requirePermission(PERMISSIONS.ORDERS_REFRESH),
  asyncHandler(orderRefreshController.getBatch)
);

module.exports = router;
