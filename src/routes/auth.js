/**
 * 认证路由
 * @module routes/auth
 * @description 用户认证相关接口（登录、登出、修改密码）
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, checkPasswordChangeRequired } = require('../middleware/authMiddleware');
const controller = require('../controllers/authController');

const router = express.Router();

// 公开接口（无需认证）
router.post('/login', asyncHandler(controller.login));

// 需要认证的接口
router.post('/logout', authenticate, asyncHandler(controller.logout));
router.post('/change-password', authenticate, asyncHandler(controller.changePassword));
router.get('/me', authenticate, asyncHandler(controller.getCurrentUser));

// 全局应用强制修改密码检查（除了上面定义的接口）
router.use(authenticate, checkPasswordChangeRequired);

module.exports = router;
