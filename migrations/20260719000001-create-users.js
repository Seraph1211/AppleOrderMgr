'use strict';

/**
 * 创建 users 表
 * @description 系统用户管理表，实现JWT认证和角色权限控制
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('users', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID，自增'
      },
      username: {
        type: Sequelize.STRING(50),
        allowNull: false,
        unique: true,
        comment: '用户名（登录用，唯一）'
      },
      password: {
        type: Sequelize.STRING(255),
        allowNull: false,
        comment: '密码（bcrypt加密）'
      },
      role: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'user',
        comment: '用户角色：admin/user'
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'active',
        comment: '账号状态：active/locked'
      },
      failed_login_attempts: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '连续登录失败次数'
      },
      locked_until: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: '锁定截止时间（NULL表示未锁定）'
      },
      force_password_change: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否强制修改密码（首次登录）'
      },
      last_login_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: '最后登录时间'
      },
      last_login_ip: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: '最后登录IP地址'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: '记录创建时间'
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: '记录更新时间'
      }
    }, {
      comment: '系统用户表'
    });

    // 创建索引
    await queryInterface.addIndex('users', ['username'], {
      unique: true,
      name: 'uk_users_username'
    });
    await queryInterface.addIndex('users', ['role'], {
      name: 'idx_users_role'
    });
    await queryInterface.addIndex('users', ['status'], {
      name: 'idx_users_status'
    });
    await queryInterface.addIndex('users', ['last_login_at'], {
      name: 'idx_users_last_login_at'
    });

    // 创建检查约束
    await queryInterface.sequelize.query(`
      ALTER TABLE users
      ADD CONSTRAINT chk_users_role CHECK (role IN ('admin', 'user'))
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE users
      ADD CONSTRAINT chk_users_status CHECK (status IN ('active', 'locked'))
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE users
      ADD CONSTRAINT chk_users_failed_attempts CHECK (failed_login_attempts >= 0)
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('users');
  }
};
