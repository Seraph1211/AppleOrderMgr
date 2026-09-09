const { randomUUID } = require('crypto');
const { User, sequelize } = require('../models');
const ApiError = require('../utils/ApiError');
const { accountId, normalizeNickname } = require('../utils/accountIdentity');
const {
  generateToken,
  generateConfirmationToken,
  verifyToken,
  decodeToken,
} = require('../utils/jwtUtils');
const logger = require('../utils/logger');
const { MIN_PASSWORD_LENGTH } = require('../constants/business');
const permissionService = require('./permissionService');

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
async function login(username, password, loginIp = null, options = {}) {
  try {
    const outcome = await sequelize.transaction(async transaction => {
      try {
        const user = await User.findOne({
          where: { username },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!user) return { error: new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误') };
        options.onIdentify?.({
          id: user.id,
          username: user.username,
          nickname: user.nickname || user.username,
        });
        if (user.status === 'locked' && user.lockedUntil && user.lockedUntil <= new Date()) {
          user.status = 'active';
          user.lockedUntil = null;
          user.failedLoginAttempts = 0;
        }
        if (user.isLocked())
          return {
            error: new ApiError(403, 'ACCOUNT_LOCKED', '账号已被锁定，请稍后重试或联系管理员'),
          };
        if (!(await user.comparePassword(password))) {
          user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
          if (user.failedLoginAttempts >= Number(process.env.MAX_LOGIN_ATTEMPTS || 5)) {
            user.status = 'locked';
            user.lockedUntil = new Date(
              Date.now() + Number(process.env.LOCK_DURATION_MINUTES || 15) * 60000
            );
          }
          await user.save({ transaction });
          // 返回错误而非事务内抛出，确保失败次数和锁定状态提交。
          return { error: new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误') };
        }
        const active =
          user.activeSessionId &&
          user.activeSessionExpiresAt &&
          new Date(user.activeSessionExpiresAt) > new Date();
        const current = options.currentToken ? verifyToken(options.currentToken) : null;
        const sameSession =
          current?.userId === user.id && current?.sessionId === user.activeSessionId;
        const confirmation = options.confirmationToken
          ? verifyToken(options.confirmationToken)
          : null;
        const confirmed =
          confirmation?.purpose === 'login_takeover' &&
          confirmation?.userId === user.id &&
          confirmation?.previousSessionId === user.activeSessionId;
        if (active && !sameSession && !confirmed) {
          return {
            error: ApiError.conflict(
              '继续登录将使上一台设备退出登录。',
              { confirmationToken: generateConfirmationToken(user) },
              'SESSION_CONFIRMATION_REQUIRED'
            ),
          };
        }
        user.activeSessionId = randomUUID();
        const token = generateToken({
          userId: user.id,
          username: user.username,
          role: user.role,
          sessionId: user.activeSessionId,
        });
        user.activeSessionExpiresAt = new Date(decodeToken(token).exp * 1000);
        user.lastLoginAt = new Date();
        user.lastLoginIp = loginIp;
        user.failedLoginAttempts = 0;
        user.forcePasswordChange = false;
        await user.save({ transaction });
        const permissions = await permissionService.getEffectivePermissions(user, { transaction });
        return {
          token,
          user: {
            id: user.id,
            accountId: accountId(user.id),
            username: user.username,
            nickname: user.nickname || user.username,
            role: user.role,
            forcePasswordChange: false,
            permissions,
            permissionsVersion: user.permissionsVersion,
            availableHome: permissionService.resolveAvailableHome(permissions),
          },
        };
      } catch (error) {
        logger.error('账号事务失败', { error: error.message });
        throw error;
      }
    });
    if (outcome.error) throw outcome.error;
    logger.info('用户登录成功', { userId: outcome.user.id, loginIp });
    return outcome;
  } catch (error) {
    if (!(error instanceof ApiError)) logger.error('登录服务失败', { error: error.message });
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
async function changePassword(userId, oldPassword, newPassword, sessionId) {
  try {
    // 验证参数
    if (
      typeof oldPassword !== 'string' ||
      typeof newPassword !== 'string' ||
      !oldPassword ||
      !newPassword
    ) {
      throw new Error('旧密码和新密码不能为空');
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`新密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`);
    }

    if (Buffer.byteLength(newPassword) > 72) throw ApiError.badRequest('密码不能超过 72 字节');

    if (oldPassword === newPassword) {
      throw new Error('新密码不能与旧密码相同');
    }

    const user = await sequelize.transaction(async transaction => {
      try {
        const target = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!target) throw new Error('用户不存在');
        if (sessionId && target.activeSessionId !== sessionId)
          throw new ApiError(401, 'SESSION_REPLACED', '登录已失效，请重新登录');
        if (!(await target.comparePassword(oldPassword))) throw new Error('旧密码错误');
        target.password = newPassword;
        target.forcePasswordChange = false;
        target.activeSessionId = null;
        target.activeSessionExpiresAt = null;
        await target.save({ transaction });
        return target;
      } catch (error) {
        logger.error('账号事务失败', { error: error.message });
        throw error;
      }
    });

    logger.info('用户密码修改成功', {
      userId: user.id,
      username: user.username,
    });
  } catch (error) {
    logger.error('修改密码服务执行失败', {
      userId,
      error: error.message,
      stack: error.stack,
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
      username: user.username,
    });

    return {
      id: user.id,
      username: user.username,
      status: user.status,
      failedLoginAttempts: user.failedLoginAttempts,
      lockedUntil: user.lockedUntil,
    };
  } catch (error) {
    logger.error('解锁用户服务执行失败', {
      userId,
      error: error.message,
      stack: error.stack,
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
        'nickname',
        'role',
        'status',
        'forcePasswordChange',
        'permissionsVersion',
        'lastLoginAt',
        'lastLoginIp',
        'createdAt',
      ],
    });

    if (!user) {
      throw new Error('用户不存在');
    }

    const permissions = await permissionService.getEffectivePermissions(user);
    return {
      id: user.id,
      username: user.username,
      accountId: accountId(user.id),
      nickname: user.nickname || user.username,
      role: user.role,
      status: user.status,
      forcePasswordChange: false,
      permissions,
      permissionsVersion: user.permissionsVersion,
      availableHome: permissionService.resolveAvailableHome(permissions),
      lastLoginAt: user.lastLoginAt,
      lastLoginIp: user.lastLoginIp,
      createdAt: user.createdAt,
    };
  } catch (error) {
    logger.error('获取用户信息失败', {
      userId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * 退出时只撤销调用方会话，避免旧请求退出新设备。
 * @param {number} userId - 用户 ID
 * @param {string} sessionId - 当前会话
 * @returns {Promise<void>}
 */
async function logout(userId, sessionId) {
  try {
    await User.update(
      { activeSessionId: null, activeSessionExpiresAt: null },
      { where: { id: userId, activeSessionId: sessionId } }
    );
  } catch (error) {
    logger.error('撤销登录失败', { userId, error: error.message });
    throw error;
  }
}

/**
 * 更新本人昵称。
 * @param {number} userId - 用户 ID
 * @param {string} nickname - 昵称
 * @returns {Promise<Object>} 最新本人资料
 */
async function updateProfile(userId, nickname) {
  try {
    await User.update({ nickname: normalizeNickname(nickname) }, { where: { id: userId } });
    return await getUserInfo(userId);
  } catch (error) {
    logger.error('更新昵称失败', { userId, error: error.message });
    throw error;
  }
}

/**
 * 管理员重置密码并撤销目标会话。
 * @param {number} userId - 目标用户 ID
 * @param {string} newPassword - 新密码
 * @returns {Promise<void>}
 */
async function resetPassword(userId, newPassword) {
  try {
    if (
      typeof newPassword !== 'string' ||
      newPassword.length < MIN_PASSWORD_LENGTH ||
      Buffer.byteLength(newPassword) > 72
    ) {
      throw ApiError.badRequest('密码至少 8 位且不能超过 72 字节');
    }
    await sequelize.transaction(async transaction => {
      try {
        const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!user) throw ApiError.notFound('用户不存在');
        user.password = newPassword;
        user.forcePasswordChange = false;
        user.activeSessionId = null;
        user.activeSessionExpiresAt = null;
        await user.save({ transaction });
      } catch (error) {
        logger.error('账号事务失败', { error: error.message });
        throw error;
      }
    });
  } catch (error) {
    logger.error('重置密码失败', { userId, error: error.message });
    throw error;
  }
}

module.exports = {
  logout,
  updateProfile,
  resetPassword,
  login,
  changePassword,
  unlockUser,
  getUserInfo,
};
