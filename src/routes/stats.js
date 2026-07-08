/**
 * 统计路由
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const controller = require('../controllers/statsController');

const router = express.Router();

router.get('/overview', asyncHandler(controller.getOverview));
router.get('/apple-ids', asyncHandler(controller.getAppleIdStats));
router.get('/recipients', asyncHandler(controller.getRecipientStats));
router.get('/products', asyncHandler(controller.getProductStats));

module.exports = router;
