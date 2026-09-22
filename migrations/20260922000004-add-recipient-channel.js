'use strict';

const logger = require('../src/utils/logger');

/** 为取机人增加独立渠道标签；存量记录保持空值。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.addColumn(
          'recipients',
          'channel',
          {
            type: Sequelize.STRING(100),
            allowNull: true,
            defaultValue: null,
            comment: '取机人渠道标签；独立于订单和取机人 TAG',
          },
          { transaction }
        );
        await queryInterface.addIndex('recipients', ['channel'], {
          name: 'idx_recipients_channel',
          transaction,
        });
      });
    } catch (error) {
      logger.warn('新增取机人渠道标签失败', { errorType: error.name });
      throw error;
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.removeIndex('recipients', 'idx_recipients_channel', {
          transaction,
        });
        await queryInterface.removeColumn('recipients', 'channel', { transaction });
      });
    } catch (error) {
      logger.warn('移除取机人渠道标签失败', { errorType: error.name });
      throw error;
    }
  },
};
