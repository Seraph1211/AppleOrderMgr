const { User } = require('../models');
const { generateToken } = require('../utils/jwtUtils');
const logger = require('../utils/logger');

/**
 * 认证服务层
 * @module services/authService
 * @description 处理用户登录、密码修改、账号锁定等认证相关业务逻辑
 */

/**
 * 用户登录
 * @param {string} username - 用户名
 * @param {string} password - 密码
 * @param {string} loginIp - 登录 IP 地址
 * @returns {Promise<Object>} 包含 token 和用户信息的对象
 * @throws {Error} 当登录失败时
 */
async function login(username, password, loginIp = null) {
  try {
    // 验证参数
    if (!username || !password) {
      throw new Error('用户名和密码不能为空');
    }

    // 查找用户
    const user = await User.findOne({
      where: { username }
    });

    if (!user) {
      logger.warn('登录失败：用户不存在', { username, loginIp });
      throw new Error('用户名或密码错误');
    }

    // 检查账号是否被锁定
    if (user.isLocked()) {
      const lockedMinutes = Math.ceil((user.lockedUntil - new Date()) / 60000);
      logger.warn('登录失败：账号已锁定', {
        userId: user.id,
        username: user.username,
        lockedUntil: user.lockedUntil,
        loginIp
      });

      throw new Error(`账号已被锁定，请在 ${lockedMinutes} 分钟后重试`);
    }

    // 验证密码
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      // 密码错误，递增失败次数
      await user.incrementFailedAttempts();

      const remainingAttempts = parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10) - user.failedLoginAttempts;

      logger.warn('登录失败：密码错误', {
        userId: user.id,
        username: user.username,
        failedAttempts: user.failedLoginAttempts,
        remainingAttempts,
        loginIp
      });

      if (remainingAttempts > 0) {
        throw new Error(`用户名或密码错误，剩余尝试次数: ${remainingAttempts}`);
      } else {
        throw new Error('登录失败次数过多，账号已被锁定 15 分钟');
      }
    }

    // 密码正确，重置失败次数
    if (user.failedLoginAttempts > 0) {
      await user.resetFailedAttempts();
    }

    // 更新最后登录时间和 IP
    user.lastLoginAt = new Date();
    user.lastLoginIp = loginIp;
    await user.save();

    // 生成 JWT token
    const token = generateToken({
      userId: user.id,
      username: user.username,
      role: user.role
    });

    logger.info('用户登录成功', {
      userId: user.id,
      username: user.username,
      role: user.role,
      loginIp
    });

    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        forcePasswordChange: user.forcePasswordChange
      }
    };
  } catch (error) {
    logger.error('登录服务执行失败', {
      username,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * 修改密码
 * @param {number} userId - 用户 ID
 * @param {string} oldPassword - 旧密码
 * @param {string} newPassword - 新密码
 * @returns {Promise<void>}
 * @throws {Error} 当修改失败时
 */
async function changePassword(userId, oldPassword, newPassword) {
  try {
    // 验证参数
    if (!oldPassword || !newPassword) {
      throw new Error('旧密码和新密码不能为空');
    }

    if (newPassword.length < 6) {
      throw new Error('新密码长度不能少于 6 位');
    }

    if (oldPassword === newPassword) {
      throw new Error('新密码不能与旧密码相同');
    }

    // 查找用户
    const user = await User.findByPk(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    // 验证旧密码
    const isOldPasswordValid = await user.comparePassword(oldPassword);

    if (!isOldPasswordValid) {
      logger.warn('修改密码失败：旧密码错误', {
        userId: user.id,
        username: user.username
      });
      throw new Error('旧密码错误');
    }

    // 更新密码（beforeUpdate hook 会自动加密）
    user.password = newPassword;
    user.forcePasswordChange = false;
    await user.save();

    logger.info('用户密码修改成功', {
      userId: user.id,
      username: user.username
    });
  } catch (error) {
    logger.error('修改密码服务执行失败', {
      userId,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * 解锁用户账号
 * @param {number} userId - 用户 ID
 * @returns {Promise<Object>} 解锁后的用户信息
 * @throws {Error} 当解锁失败时
 */
async function unlockUser(userId) {
  try {
    // 查找用户
    const user = await User.findByPk(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    // 解锁账号
    await user.unlockAccount();

    logger.info('用户账号已解锁', {
      userId: user.id,
      username: user.username
    });

    return {
      id: user.id,
      username: user.username,
      status: user.status,
      failedLoginAttempts: user.failedLoginAttempts,
      lockedUntil: user.lockedUntil
    };
  } catch (error) {
    logger.error('解锁用户服务执行失败', {
      userId,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * 获取用户信息
 * @param {number} userId - 用户 ID
 * @returns {Promise<Object>} 用户信息
 * @throws {Error} 当查询失败时
 */
async function getUserInfo(userId) {
  try {
    const user = await User.findByPk(userId, {
      attributes: [
        'id',
        'username',
        'role',
        'status',
        'forcePasswordChange',
        'lastLoginAt',
        'lastLoginIp',
        'createdAt'
      ]
    });

    if (!user) {
      throw new Error('用户不存在');
    }

    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      forcePasswordChange: user.forcePasswordChange,
      lastLoginAt: user.lastLoginAt,
      lastLoginIp: user.lastLoginIp,
      createdAt: user.createdAt
    };
  } catch (error) {
    logger.error('获取用户信息失败', {
      userId,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

module.exports = {
  login,
  changePassword,
  unlockUser,
  getUserInfo
};
