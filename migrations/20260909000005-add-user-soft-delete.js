const logger = require('../src/utils/logger');

/** 用户软删除字段；不修改存量账号。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.addColumn('users', 'deleted_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    } catch (error) {
      logger.error('用户软删除迁移失败', { error: error.message });
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.removeColumn('users', 'deleted_at');
    } catch (error) {
      logger.error('用户软删除回退失败', { error: error.message });
      throw error;
    }
  },
};
