const { verifyToken, extractTokenFromHeader } = require('../utils/jwtUtils');
const { User } = require('../models');
const logger = require('../utils/logger');

/**
 * 认证中间件
 * @module middleware/authMiddleware
 * @description 提供 JWT 认证、角色权限检查和密码修改强制检查
 */

/**
 * 验证 JWT token 中间件
 * @description 验证请求头中的 JWT token，并将用户信息附加到 req.user
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 * @param {Function} next - Express next 函数
 */
async function authenticate(req, res, next) {
  try {
    // 从请求头中提取 token
    const token = extractTokenFromHeader(req);

    if (!token) {
      logger.warn('认证失败：缺少 token', {
        path: req.path,
        method: req.method,
        ip: req.ip
      });

      return res.status(401).json({
        success: false,
        message: '未提供认证令牌，请先登录'
      });
    }

    // 验证 token
    const decoded = verifyToken(token);

    if (!decoded) {
      logger.warn('认证失败：token 无效或已过期', {
        path: req.path,
        method: req.method,
        ip: req.ip
      });

      return res.status(401).json({
        success: false,
        message: '认证令牌无效或已过期，请重新登录'
      });
    }

    // 从数据库查询用户信息（验证用户是否仍然存在且状态正常）
    const user = await User.findByPk(decoded.userId, {
      attributes: ['id', 'username', 'role', 'status', 'forcePasswordChange']
    });

    if (!user) {
      logger.warn('认证失败：用户不存在', {
        userId: decoded.userId,
        path: req.path
      });

      return res.status(401).json({
        success: false,
        message: '用户不存在或已被删除'
      });
    }

    if (user.status === 'locked') {
      logger.warn('认证失败：用户账号已被锁定', {
        userId: user.id,
        username: user.username
      });

      return res.status(403).json({
        success: false,
        message: '账号已被锁定，请联系管理员'
      });
    }

    // 将用户信息附加到请求对象
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      forcePasswordChange: user.forcePasswordChange
    };

    logger.debug('用户认证成功', {
      userId: user.id,
      username: user.username,
      role: user.role,
      path: req.path
    });

    next();
  } catch (error) {
    logger.error('认证中间件执行失败', {
      error: error.message,
      stack: error.stack,
      path: req.path
    });

    return res.status(500).json({
      success: false,
      message: '认证过程中发生错误'
    });
  }
}

/**
 * 角色权限检查中间件工厂函数
 * @description 创建一个检查用户角色的中间件，只有指定角色的用户才能访问
 * @param {Array<string>} allowedRoles - 允许的角色列表（如 ['admin']）
 * @returns {Function} Express 中间件函数
 * @example
 * router.delete('/users/:id', authenticate, requireRole(['admin']), deleteUser);
 */
function requireRole(allowedRoles) {
  return (req, res, next) => {
    try {
      // 确保已经过 authenticate 中间件
      if (!req.user) {
        logger.error('角色检查失败：用户未认证', {
          path: req.path
        });

        return res.status(401).json({
          success: false,
          message: '请先登录'
        });
      }

      // 检查用户角色是否在允许的角色列表中
      if (!allowedRoles.includes(req.user.role)) {
        logger.warn('权限不足', {
          userId: req.user.id,
          username: req.user.username,
          userRole: req.user.role,
          requiredRoles: allowedRoles,
          path: req.path
        });

        return res.status(403).json({
          success: false,
          message: '权限不足，需要管理员权限'
        });
      }

      logger.debug('角色权限检查通过', {
        userId: req.user.id,
        role: req.user.role,
        path: req.path
      });

      next();
    } catch (error) {
      logger.error('角色检查中间件执行失败', {
        error: error.message,
        stack: error.stack,
        path: req.path
      });

      return res.status(500).json({
        success: false,
        message: '权限检查过程中发生错误'
      });
    }
  };
}

/**
 * 检查是否需要强制修改密码中间件
 * @description 如果用户需要强制修改密码，只允许访问修改密码接口
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 * @param {Function} next - Express next 函数
 */
function checkPasswordChangeRequired(req, res, next) {
  try {
    // 确保已经过 authenticate 中间件
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: '请先登录'
      });
    }

    // 如果需要强制修改密码
    if (req.user.forcePasswordChange) {
      // 允许访问的路径白名单
      const allowedPaths = [
        '/api/auth/change-password',
        '/api/auth/logout',
        '/api/auth/me'
      ];

      // 检查当前请求路径是否在白名单中
      if (!allowedPaths.includes(req.path)) {
        logger.warn('强制修改密码检查：用户尝试访问其他接口', {
          userId: req.user.id,
          username: req.user.username,
          path: req.path
        });

        return res.status(403).json({
          success: false,
          message: '首次登录需要修改密码，请先修改密码后再使用系统',
          forcePasswordChange: true
        });
      }
    }

    next();
  } catch (error) {
    logger.error('密码修改检查中间件执行失败', {
      error: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      message: '密码修改检查过程中发生错误'
    });
  }
}

module.exports = {
  authenticate,
  requireRole,
  checkPasswordChangeRequired
};
