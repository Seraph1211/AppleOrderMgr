const express = require('express');

const orderRefreshController = require('../controllers/orderRefreshController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.get('/jobs/:id', asyncHandler(orderRefreshController.getJob));
router.get('/batches/:id', asyncHandler(orderRefreshController.getBatch));

module.exports = router;
