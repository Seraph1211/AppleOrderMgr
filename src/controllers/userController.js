const { User } = require('../models');
const { Op } = require('sequelize');
const authService = require('../services/authService');
const logger = require('../utils/logger');

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
    const {
      page = 1,
      limit = 20,
      role,
      status,
      keyword
    } = req.query;

    // 构建查询条件
    const where = {};

    if (role) {
      where.role = role;
    }

    if (status) {
      where.status = status;
    }

    if (keyword) {
      where.username = {
        [Op.iLike]: `%${keyword}%`
      };
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
        'role',
        'status',
        'failedLoginAttempts',
        'lastLoginAt',
        'lastLoginIp',
        'createdAt',
        'updatedAt'
      ],
      order: [['createdAt', 'DESC']],
      limit: limitNum,
      offset
    });

    logger.info('查询用户列表成功', {
      total: count,
      page: pageNum,
      limit: limitNum,
      filters: { role, status, keyword }
    });

    return res.status(200).json({
      success: true,
      data: {
        total: count,
        page: pageNum,
        limit: limitNum,
        users: rows
      }
    });
  } catch (error) {
    logger.error('查询用户列表失败', {
      error: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      message: '查询用户列表失败'
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
    const { username, password, role = 'user' } = req.body;

    // 输入验证
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: '用户名和密码不能为空'
      });
    }

    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({
        success: false,
        message: '用户名长度必须在 3-50 个字符之间'
      });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: '用户名只能包含字母、数字和下划线'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: '密码长度不能少于 6 位'
      });
    }

    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: '角色必须是 admin 或 user'
      });
    }

    // 检查用户名是否已存在
    const existingUser = await User.findOne({
      where: { username }
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: '用户名已存在'
      });
    }

    // 创建用户（beforeCreate hook 会自动加密密码）
    const user = await User.create({
      username,
      password,
      role,
      status: 'active'
    });

    logger.info('创建用户成功', {
      userId: user.id,
      username: user.username,
      role: user.role,
      createdBy: req.user.username
    });

    return res.status(201).json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt
      },
      message: '用户创建成功'
    });
  } catch (error) {
    logger.error('创建用户失败', {
      error: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      message: '创建用户失败'
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

    // 查找用户
    const user = await User.findByPk(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    // 验证更新字段
    if (role && !['admin', 'user'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: '角色必须是 admin 或 user'
      });
    }

    if (status && !['active', 'locked'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: '状态必须是 active 或 locked'
      });
    }

    // 更新用户信息
    if (role) {
      user.role = role;
    }

    if (status) {
      user.status = status;
    }

    await user.save();

    logger.info('更新用户成功', {
      userId: user.id,
      username: user.username,
      updatedFields: { role, status },
      updatedBy: req.user.username
    });

    return res.status(200).json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        updatedAt: user.updatedAt
      },
      message: '用户更新成功'
    });
  } catch (error) {
    logger.error('更新用户失败', {
      userId: req.params.id,
      error: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      message: '更新用户失败'
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
        message: '不能删除当前登录的用户'
      });
    }

    // 查找用户
    const user = await User.findByPk(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    // 检查是否是最后一个管理员
    if (user.role === 'admin') {
      const adminCount = await User.count({
        where: { role: 'admin' }
      });

      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          message: '不能删除最后一个管理员账号'
        });
      }
    }

    // 删除用户
    await user.destroy();

    logger.info('删除用户成功', {
      userId: user.id,
      username: user.username,
      role: user.role,
      deletedBy: req.user.username
    });

    return res.status(200).json({
      success: true,
      message: '用户已删除'
    });
  } catch (error) {
    logger.error('删除用户失败', {
      userId: req.params.id,
      error: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      message: '删除用户失败'
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
      unlockedBy: req.user.username
    });

    return res.status(200).json({
      success: true,
      data: user,
      message: '用户已解锁'
    });
  } catch (error) {
    logger.error('解锁用户失败', {
      userId: req.params.id,
      error: error.message,
      stack: error.stack
    });

    if (error.message === '用户不存在') {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }

    return res.status(500).json({
      success: false,
      message: '解锁用户失败'
    });
  }
}

module.exports = {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  unlockUser
};
