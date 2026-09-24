const logger = require('../src/utils/logger');

/** 取消账号有效设备会话数量限制，保留逐会话撤销能力。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_active_sessions_limit;',
          { transaction }
        );
      });
    } catch (error) {
      logger.error('取消账号设备会话限制迁移失败', { error: error.message });
      throw error;
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          ALTER TABLE users ADD CONSTRAINT users_active_sessions_limit
            CHECK (
              jsonb_typeof(active_sessions) = 'array'
              AND jsonb_array_length(active_sessions) <= 3
            );
          `,
          { transaction }
        );
      });
    } catch (error) {
      logger.error('恢复三设备会话限制迁移失败', { error: error.message });
      throw error;
    }
  },
};
