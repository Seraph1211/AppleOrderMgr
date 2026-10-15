'use strict';

const logger = require('../src/utils/logger');

/** 新增可空信用评级；保留全部存量资料，不自动评级。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.addColumn(
          'recipients',
          'credit_rating',
          {
            type: Sequelize.STRING(1),
            allowNull: true,
            defaultValue: null,
            comment: '信用评级：A/B/C；空值表示未评级',
          },
          { transaction }
        );
        await queryInterface.addConstraint('recipients', {
          fields: ['credit_rating'],
          type: 'check',
          name: 'recipients_credit_rating_check',
          where: { credit_rating: ['A', 'B', 'C'] },
          transaction,
        });
      });
    } catch (error) {
      logger.warn('新增取机人信用评级失败', { errorType: error.name });
      throw error;
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.removeConstraint('recipients', 'recipients_credit_rating_check', {
          transaction,
        });
        await queryInterface.removeColumn('recipients', 'credit_rating', { transaction });
      });
    } catch (error) {
      logger.warn('移除取机人信用评级失败', { errorType: error.name });
      throw error;
    }
  },
};
