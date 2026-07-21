/**
 * Apple ID 路由
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, requireRole } = require('../middleware/authMiddleware');
const controller = require('../controllers/appleIdController');

const router = express.Router();

// 所有接口都需要认证
router.use(authenticate);

router.get('/', asyncHandler(controller.listAppleIds));
router.get('/:id', asyncHandler(controller.getAppleIdDetail));
router.post('/', asyncHandler(controller.createAppleId));
router.put('/:id', asyncHandler(controller.updateAppleId));
router.delete('/:id', requireRole(['admin']), asyncHandler(controller.deleteAppleId));

module.exports = router;
