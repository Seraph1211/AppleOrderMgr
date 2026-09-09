const ApiError = require('../utils/ApiError');
const { extractTokenFromHeader } = require('../utils/jwtUtils');
const authService = require('../services/authService');
const logger = require('../utils/logger');
const { MIN_PASSWORD_LENGTH } = require('../constants/business');

/**
 * 认证控制器
 * @module controllers/authController
 * @description 处理用户认证相关的 HTTP 请求
 */

/**
 * 用户登录
 * @route POST /api/auth/login
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function login(req, res) {
  try {
    const { username, password } = req.body;

    // 输入验证
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({
        success: false,
        message: '用户名和密码不能为空',
      });
    }

    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({
        success: false,
        message: '用户名长度必须在 3-50 个字符之间',
      });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`,
      });
    }

    // 获取登录 IP
    const loginIp = req.ip || req.connection.remoteAddress;

    // 调用服务层处理登录
    const result = await authService.login(username, password, loginIp, {
      confirmationToken:
        typeof req.body.confirmationToken === 'string' ? req.body.confirmationToken : undefined,
      currentToken: extractTokenFromHeader(req),
      onIdentify: actor => {
        req.auditActor = actor;
      },
    });

    return res.status(200).json({
      success: true,
      data: result,
      message: '登录成功',
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('登录接口执行失败', {
      error: error.message,
      stack: error.stack,
    });

    // 根据错误信息返回不同的状态码
    if (error.message.includes('用户名或密码错误')) {
      return res.status(401).json({
        success: false,
        message: error.message,
      });
    }

    if (error.message.includes('账号已被锁定')) {
      return res.status(403).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: '登录失败，请稍后重试',
    });
  }
}

/**
 * 用户登出
 * @route POST /api/auth/logout
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function logout(req, res) {
  try {
    await authService.logout(req.user.id, req.user.sessionId);
    logger.info('用户登出', {
      userId: req.user?.id,
      username: req.user?.username,
    });

    return res.status(200).json({
      success: true,
      message: '登出成功',
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('登出接口执行失败', {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: '登出失败',
    });
  }
}

/**
 * 修改密码
 * @route POST /api/auth/change-password
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function changePassword(req, res) {
  try {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    const userId = req.user.id;

    // 输入验证
    if (
      ![oldPassword, newPassword, confirmPassword].every(
        value => typeof value === 'string' && value.length > 0
      )
    ) {
      return res.status(400).json({
        success: false,
        message: '旧密码、新密码和确认密码不能为空',
      });
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `新密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`,
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: '两次输入的新密码不一致',
      });
    }

    // 调用服务层处理密码修改
    await authService.changePassword(userId, oldPassword, newPassword, req.user.sessionId);

    return res.status(200).json({
      success: true,
      message: '密码修改成功，请重新登录',
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('修改密码接口执行失败', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
    });

    // 根据错误信息返回不同的状态码
    if (error.message.includes('旧密码错误')) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    if (error.message.includes('新密码不能与旧密码相同')) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: '修改密码失败，请稍后重试',
    });
  }
}

/**
 * 获取当前用户信息
 * @route GET /api/auth/me
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function getCurrentUser(req, res) {
  try {
    const userId = req.user.id;

    // 调用服务层获取用户信息
    const userInfo = await authService.getUserInfo(userId);

    return res.status(200).json({
      success: true,
      data: userInfo,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('获取当前用户信息失败', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: '获取用户信息失败',
    });
  }
}

/**
 * 更新本人昵称，不接受身份、权限或其他字段。
 * @param {Object} req - 请求
 * @param {Object} res - 响应
 */
async function updateProfile(req, res) {
  try {
    if (Object.keys(req.body).some(key => key !== 'nickname'))
      throw ApiError.badRequest('仅允许修改昵称');
    const user = await authService.updateProfile(req.user.id, req.body.nickname);
    return res.json({ success: true, data: user, message: '昵称已更新' });
  } catch (error) {
    logger.error('账号操作失败', { error: error.message });
    throw error;
  }
}

module.exports = {
  updateProfile,
  login,
  logout,
  changePassword,
  getCurrentUser,
};
