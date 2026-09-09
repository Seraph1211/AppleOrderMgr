/**
 * 认证路由
 * @module routes/auth
 * @description 用户认证相关接口（登录、登出、修改密码）
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate } = require('../middleware/authMiddleware');
const controller = require('../controllers/authController');

const router = express.Router();

const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: '登录请求过于频繁，请稍后重试' },
  },
});

const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `account:${String(req.body?.username || 'anonymous').toLowerCase()}`,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: '该账号登录尝试过多，请稍后重试' },
  },
});

// 公开接口（无需认证）
router.post('/login', loginIpLimiter, loginAccountLimiter, asyncHandler(controller.login));

// 需要认证的接口
router.post('/logout', authenticate, asyncHandler(controller.logout));
router.post('/change-password', authenticate, asyncHandler(controller.changePassword));
router.patch('/profile', authenticate, asyncHandler(controller.updateProfile));
router.get('/me', authenticate, asyncHandler(controller.getCurrentUser));

module.exports = router;
