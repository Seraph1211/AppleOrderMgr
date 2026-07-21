const { DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');

/**
 * User 模型 - 系统用户管理
 * @module models/User
 * @description 管理系统登录用户，实现基于JWT的认证和角色权限控制
 */

/**
 * 定义 User 模型
 * @param {import('sequelize').Sequelize} sequelize - Sequelize实例
 * @returns {import('sequelize').Model} User模型
 */
module.exports = (sequelize) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      comment: '主键ID，自增'
    },
    username: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
      comment: '用户名（登录用，唯一）',
      validate: {
        len: {
          args: [3, 50],
          msg: '用户名长度必须在3-50个字符之间'
        },
        is: {
          args: /^[a-zA-Z0-9_]+$/,
          msg: '用户名只能包含字母、数字和下划线'
        }
      }
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: '密码（bcrypt加密）'
    },
    role: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'user',
      comment: '用户角色：admin/user',
      validate: {
        isIn: {
          args: [['admin', 'user']],
          msg: '角色必须是：admin 或 user'
        }
      }
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'active',
      comment: '账号状态：active/locked',
      validate: {
        isIn: {
          args: [['active', 'locked']],
          msg: '状态必须是：active 或 locked'
        }
      }
    },
    failedLoginAttempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'failed_login_attempts',
      comment: '连续登录失败次数',
      validate: {
        min: {
          args: [0],
          msg: '失败次数不能为负数'
        }
      }
    },
    lockedUntil: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'locked_until',
      comment: '锁定截止时间（NULL表示未锁定）'
    },
    forcePasswordChange: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'force_password_change',
      comment: '是否强制修改密码（首次登录）'
    },
    lastLoginAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'last_login_at',
      comment: '最后登录时间'
    },
    lastLoginIp: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: 'last_login_ip',
      comment: '最后登录IP地址'
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'created_at',
      comment: '记录创建时间'
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'updated_at',
      comment: '记录更新时间'
    }
  }, {
    tableName: 'users',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['username'],
        name: 'uk_users_username'
      },
      {
        fields: ['role'],
        name: 'idx_users_role'
      },
      {
        fields: ['status'],
        name: 'idx_users_status'
      },
      {
        fields: ['last_login_at'],
        name: 'idx_users_last_login_at'
      }
    ],
    comment: '系统用户表',
    hooks: {
      /**
       * 创建用户前，自动加密密码
       */
      beforeCreate: async (user) => {
        if (user.password) {
          const salt = await bcrypt.genSalt(10);
          user.password = await bcrypt.hash(user.password, salt);
        }
      },
      /**
       * 更新用户前，如果密码变更则自动加密
       */
      beforeUpdate: async (user) => {
        if (user.changed('password')) {
          const salt = await bcrypt.genSalt(10);
          user.password = await bcrypt.hash(user.password, salt);
        }
      }
    }
  });

  /**
   * 实例方法：比较密码
   * @param {string} candidatePassword - 待验证的密码
   * @returns {Promise<boolean>} 密码是否匹配
   */
  User.prototype.comparePassword = async function(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
  };

  /**
   * 实例方法：递增失败次数
   * @returns {Promise<void>}
   */
  User.prototype.incrementFailedAttempts = async function() {
    // 确保 failedLoginAttempts 有默认值，避免 undefined + 1 = NaN
    this.failedLoginAttempts = (this.failedLoginAttempts || 0) + 1;

    // 达到最大失败次数（5次），锁定账号15分钟
    const MAX_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10);
    const LOCK_DURATION = parseInt(process.env.LOCK_DURATION_MINUTES || '15', 10);

    if (this.failedLoginAttempts >= MAX_ATTEMPTS) {
      this.status = 'locked';
      this.lockedUntil = new Date(Date.now() + LOCK_DURATION * 60 * 1000);
    }

    await this.save();
  };

  /**
   * 实例方法：重置失败次数
   * @returns {Promise<void>}
   */
  User.prototype.resetFailedAttempts = async function() {
    this.failedLoginAttempts = 0;
    await this.save();
  };

  /**
   * 实例方法：锁定账号
   * @param {number} durationMinutes - 锁定时长（分钟）
   * @returns {Promise<void>}
   */
  User.prototype.lockAccount = async function(durationMinutes = 15) {
    this.status = 'locked';
    this.lockedUntil = new Date(Date.now() + durationMinutes * 60 * 1000);
    await this.save();
  };

  /**
   * 实例方法：解锁账号
   * @returns {Promise<void>}
   */
  User.prototype.unlockAccount = async function() {
    this.status = 'active';
    this.lockedUntil = null;
    this.failedLoginAttempts = 0;
    await this.save();
  };

  /**
   * 实例方法：检查账号是否被锁定
   * @returns {boolean} 是否被锁定
   */
  User.prototype.isLocked = function() {
    return this.status === 'locked' && this.lockedUntil && this.lockedUntil > new Date();
  };

  return User;
};
