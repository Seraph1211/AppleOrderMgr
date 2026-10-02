'use strict';

module.exports = {
  /** 创建独立库存验证状态与请求证据表。 */
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.createTable(
            'inventory_validation_state',
            {
              id: { type: Sequelize.STRING(50), primaryKey: true },
              body: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
              updated_at: { type: Sequelize.DATE, allowNull: false },
            },
            { transaction }
          );
          await queryInterface.createTable(
            'inventory_validation_attempts',
            {
              id: { type: Sequelize.UUID, primaryKey: true },
              purpose: { type: Sequelize.STRING(20), allowNull: false },
              egress: { type: Sequelize.STRING(40), allowNull: false },
              context: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
              started_at: { type: Sequelize.DATE, allowNull: false },
              finished_at: { type: Sequelize.DATE },
              outcome: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'reserved' },
              http_status: { type: Sequelize.INTEGER },
              duration_ms: { type: Sequelize.INTEGER },
              response_bytes: { type: Sequelize.INTEGER },
              summary: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            },
            { transaction }
          );
          await queryInterface.addIndex('inventory_validation_attempts', ['started_at'], {
            transaction,
          });
          await queryInterface.bulkInsert(
            'inventory_validation_state',
            [
              {
                id: 'inventory-validation',
                body: '{}',
                updated_at: new Date(),
              },
            ],
            { transaction }
          );
        } catch (error) {
          throw new Error('库存验证迁移失败', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('库存验证迁移失败', { cause: error });
    }
  },
  /** 仅在独立验证库回滚验证表。 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.dropTable('inventory_validation_attempts', { transaction });
          await queryInterface.dropTable('inventory_validation_state', { transaction });
        } catch (error) {
          throw new Error('库存验证迁移失败', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('库存验证迁移失败', { cause: error });
    }
  },
};
