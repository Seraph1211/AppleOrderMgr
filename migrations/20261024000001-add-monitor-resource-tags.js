'use strict';
const logger = require('../src/utils/logger');

/** 独立保存人工标签，不修改日志原文与采集器配置。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          const time = {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          };
          await queryInterface.createTable(
            'monitor_resource_tags',
            {
              id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
              device_id: {
                type: Sequelize.UUID,
                allowNull: false,
                references: { model: 'aos_devices', key: 'id' },
                onDelete: 'CASCADE',
              },
              local_id: { type: Sequelize.UUID, allowNull: true },
              tag: { type: Sequelize.STRING(100), allowNull: false, defaultValue: '' },
              version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
              created_at: time,
              updated_at: time,
            },
            { transaction }
          );
          await queryInterface.addIndex('monitor_resource_tags', ['device_id'], {
            unique: true,
            name: 'monitor_resource_tags_device_unique',
            where: { local_id: null },
            transaction,
          });
          await queryInterface.addIndex('monitor_resource_tags', ['device_id', 'local_id'], {
            unique: true,
            name: 'monitor_resource_tags_instance_unique',
            where: { local_id: { [Sequelize.Op.ne]: null } },
            transaction,
          });
        } catch (error) {
          logger.warn('人工监控标签迁移失败', { errorCode: error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.warn('人工监控标签迁移失败', { errorCode: error.name });
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.dropTable('monitor_resource_tags', { transaction });
        } catch (error) {
          logger.warn('人工监控标签回退失败', { errorCode: error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.warn('人工监控标签回退失败', { errorCode: error.name });
      throw error;
    }
  },
};
