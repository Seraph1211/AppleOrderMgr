'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query('DROP INDEX uq_order_refresh_batches_active', {
        transaction,
      });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uq_order_refresh_batches_active
        ON order_refresh_batches ((COALESCE(requested_by, 0)))
        WHERE status IN ('pending', 'running')`,
        { transaction }
      );
      await queryInterface.addColumn(
        'users',
        'order_access',
        {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: { mode: 'all', tags: [] },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE users ALTER COLUMN order_access
        SET DEFAULT '{"mode":"tags","tags":[]}'::jsonb`,
        { transaction }
      );
      for (const column of ['before_order_access', 'after_order_access']) {
        await queryInterface.addColumn(
          'user_permission_events',
          column,
          {
            type: Sequelize.JSONB,
            allowNull: true,
          },
          { transaction }
        );
      }
      await queryInterface.addColumn(
        'order_refresh_batches',
        'order_ids',
        {
          type: Sequelize.JSONB,
          allowNull: true,
        },
        { transaction }
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      // 若存在多个活动批次，恢复旧唯一约束失败并整体回滚，须先等待批次结束。
      await queryInterface.sequelize.query('DROP INDEX uq_order_refresh_batches_active', {
        transaction,
      });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uq_order_refresh_batches_active
        ON order_refresh_batches ((1)) WHERE status IN ('pending', 'running')`,
        { transaction }
      );
      await queryInterface.removeColumn('order_refresh_batches', 'order_ids', { transaction });
      for (const column of ['before_order_access', 'after_order_access']) {
        await queryInterface.removeColumn('user_permission_events', column, { transaction });
      }
      await queryInterface.removeColumn('users', 'order_access', { transaction });
    });
  },
};
