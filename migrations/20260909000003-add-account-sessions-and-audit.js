const logger = require('../src/utils/logger');
('use strict');

/** 新增账号昵称、唯一会话与持久化操作日志。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.addColumn(
          'users',
          'nickname',
          { type: Sequelize.STRING(50), allowNull: true },
          { transaction }
        );
        await queryInterface.addColumn(
          'users',
          'active_session_id',
          { type: Sequelize.UUID, allowNull: true },
          { transaction }
        );
        await queryInterface.addColumn(
          'users',
          'active_session_expires_at',
          { type: Sequelize.DATE, allowNull: true },
          { transaction }
        );
        await queryInterface.createTable(
          'operation_logs',
          {
            id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
            actor_user_id: { type: Sequelize.INTEGER, allowNull: true },
            username: { type: Sequelize.STRING(50), allowNull: true },
            nickname: { type: Sequelize.STRING(50), allowNull: true },
            action: { type: Sequelize.STRING(100), allowNull: false },
            target: { type: Sequelize.STRING(500), allowNull: false },
            method: { type: Sequelize.STRING(10), allowNull: false },
            ip: { type: Sequelize.STRING(64), allowNull: true },
            status_code: { type: Sequelize.INTEGER, allowNull: false },
            result: { type: Sequelize.STRING(20), allowNull: false },
            request_id: { type: Sequelize.UUID, allowNull: false },
            created_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.fn('NOW'),
            },
          },
          { transaction }
        );
        for (const fields of [
          ['created_at'],
          ['actor_user_id', 'created_at'],
          ['action', 'created_at'],
        ]) {
          await queryInterface.addIndex('operation_logs', fields, { transaction });
        }
      });
    } catch (error) {
      logger.error('账号数据迁移失败', { error: error.message });
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.dropTable('operation_logs', { transaction });
        for (const column of ['active_session_expires_at', 'active_session_id', 'nickname']) {
          await queryInterface.removeColumn('users', column, { transaction });
        }
      });
    } catch (error) {
      logger.error('账号数据迁移失败', { error: error.message });
      throw error;
    }
  },
};
