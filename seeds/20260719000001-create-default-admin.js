'use strict';
/* eslint-disable camelcase */

const bcrypt = require('bcryptjs');

/**
 * 创建默认管理员账号
 * @description 仅在显式配置 ADMIN_INITIAL_PASSWORD 时创建管理员
 */
module.exports = {
  up: async (queryInterface, _Sequelize) => {
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD;
    if (!initialPassword || initialPassword.length < 12) {
      throw new Error('ADMIN_INITIAL_PASSWORD 必须显式配置且至少 12 位');
    }
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(initialPassword, salt);

    // 检查是否已存在 admin 用户
    const [users] = await queryInterface.sequelize.query(
      "SELECT id FROM users WHERE username = 'admin'"
    );

    if (users.length === 0) {
      // 插入默认管理员账号
      await queryInterface.bulkInsert('users', [
        {
          username: 'admin',
          password: passwordHash,
          role: 'admin',
          status: 'active',
          failed_login_attempts: 0,
          locked_until: null,
          force_password_change: true,
          last_login_at: null,
          last_login_ip: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
    }
  },

  down: async (queryInterface, _Sequelize) => {
    // 删除默认管理员账号
    await queryInterface.bulkDelete('users', {
      username: 'admin',
    });
  },
};
