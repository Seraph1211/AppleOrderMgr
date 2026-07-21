/**
 * 用户管理路由
 * @module routes/users
 * @description 用户管理接口（仅管理员）
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, requireRole } = require('../middleware/authMiddleware');
const controller = require('../controllers/userController');

const router = express.Router();

// 所有用户管理接口都需要管理员权限
router.use(authenticate, requireRole(['admin']));

router.get('/', asyncHandler(controller.listUsers));
router.post('/', asyncHandler(controller.createUser));
router.put('/:id', asyncHandler(controller.updateUser));
router.delete('/:id', asyncHandler(controller.deleteUser));
router.put('/:id/unlock', asyncHandler(controller.unlockUser));

module.exports = router;
