const { accountId, normalizeNickname } = require('../utils/accountIdentity');
const {
  User,
  PaymentTask,
  PaymentTaskEvent,
  UserPermissionEvent,
  OrderPayerEvent,
  PaymentStaffSetting,
  PaymentDispatchEvent,
  sequelize,
} = require('../models');
const { Op } = require('sequelize');
const authService = require('../services/authService');
const logger = require('../utils/logger');
const { MIN_PASSWORD_LENGTH, USER_ROLES } = require('../constants/business');
const permissionService = require('../services/permissionService');
const ApiError = require('../utils/ApiError');

/**
 * 用户管理控制器
 * @module controllers/userController
 * @description 处理用户管理相关的 HTTP 请求（仅管理员）
 */

/**
 * 获取用户列表
 * @route GET /api/users
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function listUsers(req, res) {
  try {
    const { page = 1, limit = 20, role, status, keyword } = req.query;

    // 构建查询条件
    const where = {};

    if (role) {
      where.role = role;
    }

    if (status) {
      where.status = status;
    }

    if (keyword) {
      const term = String(keyword).trim();
      where[Op.or] = [
        { username: { [Op.iLike]: `%${term}%` } },
        { nickname: { [Op.iLike]: `%${term}%` } },
      ];
      if (/^U\d+$/i.test(term) && Number(term.slice(1)) <= 2147483647)
        where[Op.or].push({ id: Number(term.slice(1)) });
    }

    // 分页参数
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const offset = (pageNum - 1) * limitNum;

    // 查询用户列表
    const { count, rows } = await User.findAndCountAll({
      where,
      attributes: [
        'id',
        'username',
        'nickname',
        'role',
        'status',
        'failedLoginAttempts',
        'lastLoginAt',
        'lastLoginIp',
        'createdAt',
        'updatedAt',
        'permissionsVersion',
      ],
      order: [['createdAt', 'DESC']],
      limit: limitNum,
      offset,
    });

    logger.info('查询用户列表成功', {
      total: count,
      page: pageNum,
      limit: limitNum,
      filters: { role, status, keyword },
    });

    return res.status(200).json({
      success: true,
      data: {
        total: count,
        page: pageNum,
        limit: limitNum,
        users: rows.map(user => ({
          ...user.toJSON(),
          accountId: accountId(user.id),
          nickname: user.nickname || user.username,
        })),
      },
    });
  } catch (error) {
    logger.error('查询用户列表失败', {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: '查询用户列表失败',
    });
  }
}

/**
 * 创建用户
 * @route POST /api/users
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function createUser(req, res) {
  try {
    const { username, password, role = 'operator', permissions = [] } = req.body;
    const nickname = normalizeNickname(req.body.nickname ?? username);

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

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: '用户名只能包含字母、数字和下划线',
      });
    }

    if (Buffer.byteLength(password) > 72) throw ApiError.badRequest('密码不能超过 72 字节');

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`,
      });
    }

    if (!USER_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: '角色必须是 admin、operator 或 readOnly',
      });
    }

    // 检查用户名是否已存在
    const existingUser = await User.findOne({
      where: { username },
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: '用户名已存在',
      });
    }

    // 用户与初始权限必须原子创建，避免出现短暂的角色默认授权窗口。
    const created = await permissionService.createUserWithPermissions(
      {
        username,
        nickname,
        password,
        role,
        status: 'active',
        forcePasswordChange: false,
      },
      permissions,
      req.user.id
    );
    const { user } = created;
    req.auditTarget = `账号 ${accountId(user.id)}（${user.username}）`;

    logger.info('创建用户成功', {
      userId: user.id,
      username: user.username,
      role: user.role,
      createdBy: req.user.username,
    });

    return res.status(201).json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        accountId: accountId(user.id),
        nickname: user.nickname || user.username,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        permissions: created.permissions,
        permissionsVersion: user.permissionsVersion,
      },
      message: '用户创建成功',
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('创建用户失败', {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: '创建用户失败',
    });
  }
}

/**
 * 更新用户
 * @route PUT /api/users/:id
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const { role, status } = req.body;
    if (Object.keys(req.body).some(key => !['role', 'status', 'nickname'].includes(key)))
      throw ApiError.badRequest('只允许修改角色、状态和昵称');
    const nickname =
      req.body.nickname === undefined ? undefined : normalizeNickname(req.body.nickname);

    // 验证更新字段
    if (role && !USER_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: '角色必须是 admin、operator 或 readOnly',
      });
    }

    if (status && !['active', 'locked'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: '状态必须是 active 或 locked',
      });
    }

    const user = await sequelize.transaction(async transaction => {
      await sequelize.query('SELECT pg_advisory_xact_lock(742092)', { transaction });
      const target = await User.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!target) throw ApiError.notFound('用户不存在');

      const nextRole = role || target.role;
      const nextStatus = status || target.status;
      if (
        target.role === 'admin' &&
        target.status === 'active' &&
        (nextRole !== 'admin' || nextStatus !== 'active')
      ) {
        const activeAdminCount = await User.count({
          where: { role: 'admin', status: 'active' },
          transaction,
        });
        if (activeAdminCount <= 1) {
          throw ApiError.badRequest('不能降级或锁定最后一个可用管理员账号');
        }
      }

      target.role = nextRole;
      target.status = nextStatus;
      if (nickname !== undefined) target.nickname = nickname;
      if (status === 'locked') {
        target.lockedUntil = null;
        target.activeSessionId = null;
        target.activeSessionExpiresAt = null;
      }
      await target.save({ transaction });
      return target;
    });

    logger.info('更新用户成功', {
      userId: user.id,
      username: user.username,
      updatedFields: { role, status },
      updatedBy: req.user.username,
    });

    return res.status(200).json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        accountId: accountId(user.id),
        nickname: user.nickname || user.username,
        role: user.role,
        status: user.status,
        updatedAt: user.updatedAt,
      },
      message: '用户更新成功',
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('更新用户失败', {
      userId: req.params.id,
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: '更新用户失败',
    });
  }
}

/**
 * 删除用户
 * @route DELETE /api/users/:id
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function deleteUser(req, res) {
  try {
    const { id } = req.params;
    const currentUserId = req.user.id;

    // 不能删除自己
    if (parseInt(id, 10) === currentUserId) {
      return res.status(400).json({
        success: false,
        message: '不能删除当前登录的用户',
      });
    }

    // 查找用户
    const user = await User.findByPk(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: '用户不存在',
      });
    }

    // 检查是否是最后一个管理员
    if (user.role === 'admin') {
      const adminCount = await User.count({
        where: { role: 'admin' },
      });

      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          message: '不能删除最后一个管理员账号',
        });
      }
    }

    const referenceCounts = await Promise.all([
      PaymentTask.count({ where: { assigneeUserId: user.id } }),
      PaymentStaffSetting.count({ where: { userId: user.id } }),
      UserPermissionEvent.count({
        where: { [Op.or]: [{ userId: user.id }, { actorUserId: user.id }] },
      }),
      PaymentTaskEvent.count({
        where: {
          [Op.or]: [{ actorUserId: user.id }, { fromUserId: user.id }, { toUserId: user.id }],
        },
      }),
      OrderPayerEvent.count({ where: { actorUserId: user.id } }),
      PaymentDispatchEvent.count({ where: { actorUserId: user.id } }),
    ]);
    if (referenceCounts.some(count => count > 0)) {
      return res.status(409).json({
        success: false,
        message: '用户已被付款任务或审计记录引用，请锁定账号并完成交接',
      });
    }

    // 删除用户
    await user.destroy();

    logger.info('删除用户成功', {
      userId: user.id,
      username: user.username,
      role: user.role,
      deletedBy: req.user.username,
    });

    return res.status(200).json({
      success: true,
      message: '用户已删除',
    });
  } catch (error) {
    logger.error('删除用户失败', {
      userId: req.params.id,
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: '删除用户失败',
    });
  }
}

/**
 * 解锁用户
 * @route PUT /api/users/:id/unlock
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function unlockUser(req, res) {
  try {
    const { id } = req.params;

    // 调用服务层解锁用户
    const user = await authService.unlockUser(id);

    logger.info('解锁用户成功', {
      userId: user.id,
      username: user.username,
      unlockedBy: req.user.username,
    });

    return res.status(200).json({
      success: true,
      data: user,
      message: '用户已解锁',
    });
  } catch (error) {
    logger.error('解锁用户失败', {
      userId: req.params.id,
      error: error.message,
      stack: error.stack,
    });

    if (error.message === '用户不存在') {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: '解锁用户失败',
    });
  }
}

/**
 * 管理员重置目标账号密码。
 * @param {Object} req - 请求
 * @param {Object} res - 响应
 */
async function resetPassword(req, res) {
  try {
    const { newPassword, confirmPassword } = req.body;
    if (!/^\d+$/.test(req.params.id)) throw ApiError.badRequest('账号 ID 无效');
    if (newPassword !== confirmPassword) throw ApiError.badRequest('两次输入的新密码不一致');
    await authService.resetPassword(req.params.id, newPassword);
    return res.json({ success: true, message: '密码已重置，原登录已失效' });
  } catch (error) {
    logger.error('账号操作失败', { error: error.message });
    throw error;
  }
}

module.exports = {
  resetPassword,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  unlockUser,
};
