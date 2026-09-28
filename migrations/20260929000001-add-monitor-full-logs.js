'use strict';
const logger = require('../src/utils/logger');

/** 完整运行日志独立存储；不改变订单及告警保留策略。 */
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
          const device = {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: 'aos_devices', key: 'id' },
            onDelete: 'CASCADE',
          };
          await queryInterface.createTable(
            'monitor_log_entries',
            {
              id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
              device_id: device,
              local_id: { type: Sequelize.UUID, allowNull: false },
              file_id: { type: Sequelize.UUID, allowNull: false },
              file_name: { type: Sequelize.STRING(255), allowNull: false },
              business_date: { type: Sequelize.DATEONLY, allowNull: false },
              logged_at: { type: Sequelize.DATE },
              sort_at: { type: Sequelize.DATE, allowNull: false },
              account_number: { type: Sequelize.STRING(64) },
              line_number: { type: Sequelize.BIGINT, allowNull: false },
              part_index: { type: Sequelize.INTEGER, allowNull: false },
              byte_offset: { type: Sequelize.BIGINT, allowNull: false },
              message: { type: Sequelize.TEXT, allowNull: false },
              raw_base64: { type: Sequelize.TEXT },
              parse_state: { type: Sequelize.STRING(30), allowNull: false },
              payload_hash: { type: Sequelize.STRING(64), allowNull: false },
              created_at: time,
              updated_at: time,
            },
            { transaction }
          );
          await queryInterface.addIndex(
            'monitor_log_entries',
            ['device_id', 'file_id', 'byte_offset'],
            { unique: true, name: 'monitor_log_position_unique', transaction }
          );
          await queryInterface.addIndex(
            'monitor_log_entries',
            ['device_id', 'local_id', 'business_date', 'sort_at', 'file_id', 'byte_offset', 'id'],
            { name: 'monitor_log_instance_page', transaction }
          );
          await queryInterface.addIndex(
            'monitor_log_entries',
            [
              'device_id',
              'local_id',
              'business_date',
              'account_number',
              'sort_at',
              'file_id',
              'byte_offset',
              'id',
            ],
            { name: 'monitor_log_account_page', transaction }
          );
          await queryInterface.addIndex('monitor_log_entries', ['business_date'], { transaction });
          await queryInterface.createTable(
            'monitor_log_states',
            {
              id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
              device_id: device,
              local_id: { type: Sequelize.UUID, allowNull: false },
              label: { type: Sequelize.STRING(100), allowNull: false },
              observed_at: { type: Sequelize.DATE, allowNull: false },
              snapshot: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
              created_at: time,
              updated_at: time,
            },
            { transaction }
          );
          await queryInterface.addIndex('monitor_log_states', ['device_id', 'local_id'], {
            unique: true,
            transaction,
          });
        } catch (error) {
          logger.warn('完整日志迁移未完成', { errorCode: error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.warn('完整日志迁移未完成', { errorCode: error.name });
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.dropTable('monitor_log_states', { transaction });
          await queryInterface.dropTable('monitor_log_entries', { transaction });
        } catch (error) {
          logger.warn('完整日志迁移未完成', { errorCode: error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.warn('完整日志迁移未完成', { errorCode: error.name });
      throw error;
    }
  },
};
