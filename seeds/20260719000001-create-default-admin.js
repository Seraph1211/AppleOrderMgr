'use strict';

const bcrypt = require('bcrypt');

/**
 * 创建默认管理员账号
 * @description 初始化系统默认管理员账号（username: admin, password: admin123）
 * 不强制修改密码（根据用户需求）
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 生成密码哈希（admin123）
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('admin123', salt);

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
          force_password_change: false,  // 不强制修改密码
          last_login_at: null,
          last_login_ip: null,
          created_at: new Date(),
          updated_at: new Date()
        }
      ]);

      console.log('✅ 默认管理员账号创建成功');
      console.log('   用户名: admin');
      console.log('   密码: admin123');
    } else {
      console.log('ℹ️  管理员账号已存在，跳过创建');
    }
  },

  down: async (queryInterface, Sequelize) => {
    // 删除默认管理员账号
    await queryInterface.bulkDelete('users', {
      username: 'admin'
    });
  }
};
