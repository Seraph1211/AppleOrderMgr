'use strict';
const logger = require('../src/utils/logger');

/** 官网生命周期与导入来源快照；不建立状态历史表。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.addColumn(
          'orders',
          'source_snapshot',
          {
            type: Sequelize.JSONB,
            allowNull: true,
            defaultValue: null,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'official_raw_status',
          {
            type: Sequelize.STRING(100),
            allowNull: true,
            defaultValue: null,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'official_status_description',
          {
            type: Sequelize.STRING(255),
            allowNull: true,
            defaultValue: null,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'official_status_observed_at',
          {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'official_fulfillment_message',
          {
            type: Sequelize.TEXT,
            allowNull: true,
            defaultValue: null,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'official_payment_expires_at',
          {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'official_payment_method',
          {
            type: Sequelize.STRING(50),
            allowNull: true,
            defaultValue: null,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'official_status_needs_review',
          {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'official_all_items_terminal',
          {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'official_field_diagnostics',
          {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: {},
          },
          { transaction }
        );
        await queryInterface.addIndex('orders', ['official_payment_expires_at'], {
          name: 'idx_orders_official_payment_expires_at',
          transaction,
        });
      });
    } catch (error) {
      logger.error('官网生命周期迁移失败');
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `UPDATE orders SET status = CASE status
          WHEN 'payment_due' THEN 'pending' WHEN 'payment_received' THEN 'processing'
          WHEN 'picked_up' THEN 'completed' WHEN 'payment_expired' THEN 'cancelled' ELSE status END,
          pickup_status = CASE pickup_status WHEN 'not_ready' THEN NULL
          WHEN 'ready_for_pickup' THEN 'not_picked_up' WHEN 'not_applicable' THEN NULL ELSE pickup_status END`,
          { transaction }
        );
        await queryInterface.removeIndex('orders', 'idx_orders_official_payment_expires_at', {
          transaction,
        });
        await queryInterface.removeColumn('orders', 'official_field_diagnostics', { transaction });
        await queryInterface.removeColumn('orders', 'official_all_items_terminal', { transaction });
        await queryInterface.removeColumn('orders', 'official_status_needs_review', {
          transaction,
        });
        await queryInterface.removeColumn('orders', 'official_payment_method', { transaction });
        await queryInterface.removeColumn('orders', 'official_payment_expires_at', { transaction });
        await queryInterface.removeColumn('orders', 'official_fulfillment_message', {
          transaction,
        });
        await queryInterface.removeColumn('orders', 'official_status_observed_at', { transaction });
        await queryInterface.removeColumn('orders', 'official_status_description', { transaction });
        await queryInterface.removeColumn('orders', 'official_raw_status', { transaction });
        await queryInterface.removeColumn('orders', 'source_snapshot', { transaction });
      });
    } catch (error) {
      logger.error('官网生命周期回滚失败');
      throw error;
    }
  },
};
