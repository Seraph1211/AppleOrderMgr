'use strict';

const logger = require('../src/utils/logger');

/** 删除不再使用的 Apple ID 修改标记及索引。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.removeIndex('apple_ids', 'idx_apple_ids_is_modified', {
          transaction,
        });
        await queryInterface.removeColumn('apple_ids', 'is_modified', { transaction });
      });
    } catch (error) {
      logger.warn('删除 Apple ID 修改标记失败', { errorType: error.name });
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.addColumn(
          'apple_ids',
          'is_modified',
          {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          { transaction }
        );
        await queryInterface.addIndex('apple_ids', ['is_modified'], {
          name: 'idx_apple_ids_is_modified',
          transaction,
        });
      });
    } catch (error) {
      logger.warn('恢复 Apple ID 修改标记失败', { errorType: error.name });
      throw error;
    }
  },
};
