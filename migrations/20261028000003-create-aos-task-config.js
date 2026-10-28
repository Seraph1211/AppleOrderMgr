'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        const timestamps = {
          created_at: { type: Sequelize.DATE, allowNull: false },
          updated_at: { type: Sequelize.DATE, allowNull: false },
        };
        await queryInterface.createTable(
          'aos_task_configs',
          {
            instance_id: {
              type: Sequelize.UUID,
              primaryKey: true,
              allowNull: false,
              references: { model: 'monitor_instances', key: 'id' },
              onDelete: 'RESTRICT',
            },
            last_actor_id: { type: Sequelize.INTEGER, allowNull: true },
            revision: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            current_version_id: { type: Sequelize.UUID, allowNull: true },
            last_confirmed_at: { type: Sequelize.DATE, allowNull: true },
            invalidated_at: { type: Sequelize.DATE, allowNull: true },
            ...timestamps,
          },
          { transaction }
        );
        await queryInterface.createTable(
          'aos_task_config_versions',
          {
            id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
            instance_id: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'monitor_instances', key: 'id' },
              onDelete: 'RESTRICT',
            },
            number: { type: Sequelize.INTEGER, allowNull: false },
            effective_at: { type: Sequelize.DATE, allowNull: false },
            effective_to: { type: Sequelize.DATE, allowNull: true },
            actor_id: { type: Sequelize.INTEGER, allowNull: false },
            source: { type: Sequelize.STRING(16), allowNull: false },
            restored_from_id: { type: Sequelize.UUID, allowNull: true },
            content_hash: { type: Sequelize.STRING(64), allowNull: false },
            rows: { type: Sequelize.JSONB, allowNull: false },
            aggregates: { type: Sequelize.JSONB, allowNull: false },
            task_count: { type: Sequelize.INTEGER, allowNull: false },
            city_count: { type: Sequelize.INTEGER, allowNull: false },
            spec_count: { type: Sequelize.INTEGER, allowNull: false },
            blank_line_count: { type: Sequelize.INTEGER, allowNull: false },
            ...timestamps,
          },
          { transaction }
        );
        await queryInterface.addIndex('aos_task_config_versions', ['instance_id', 'number'], {
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('aos_task_config_versions', ['instance_id', 'effective_at'], {
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('aos_task_config_versions', ['instance_id'], {
          unique: true,
          where: { effective_to: null },
          transaction,
          name: 'aos_task_config_versions_one_active',
        });
        await queryInterface.createTable(
          'aos_task_config_previews',
          {
            id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
            instance_id: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'monitor_instances', key: 'id' },
              onDelete: 'RESTRICT',
            },
            actor_id: { type: Sequelize.INTEGER, allowNull: false },
            expected_revision: { type: Sequelize.INTEGER, allowNull: false },
            expires_at: { type: Sequelize.DATE, allowNull: false },
            payload: { type: Sequelize.JSONB, allowNull: false },
            ...timestamps,
          },
          { transaction }
        );
        await queryInterface.addIndex('aos_task_config_previews', ['expires_at'], { transaction });
      });
    } catch (error) {
      throw new Error('AOS_TASK_CONFIG_MIGRATION_FAILED', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        for (const name of [
          'aos_task_config_previews',
          'aos_task_config_versions',
          'aos_task_configs',
        ])
          await queryInterface.dropTable(name, { transaction });
      });
    } catch (error) {
      throw new Error('AOS_TASK_CONFIG_ROLLBACK_FAILED', { cause: error });
    }
  },
};
