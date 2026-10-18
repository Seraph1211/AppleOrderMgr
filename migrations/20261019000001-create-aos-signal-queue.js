const TABLES = ['aos_signal_inbox', 'aos_signal_contexts'];

module.exports = {
  /** 创建独立脱敏信号队列与任务上下文，不触及原始日志。 */
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          for (const table of TABLES) {
            await queryInterface.createTable(
              table,
              {
                id: { type: Sequelize.STRING(200), primaryKey: true, allowNull: false },
                body: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
                created_at: {
                  type: Sequelize.DATE,
                  allowNull: false,
                  defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
                },
                updated_at: {
                  type: Sequelize.DATE,
                  allowNull: false,
                  defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
                },
              },
              { transaction }
            );
            await queryInterface.addIndex(table, ['created_at', 'id'], { transaction });
            await queryInterface.addIndex(table, ['updated_at', 'id'], { transaction });
          }
        } catch (error) {
          throw new Error('AOS_SIGNAL_MIGRATION_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('AOS_SIGNAL_MIGRATION_FAILED', { cause: error });
    }
  },
  /** 回退只移除新队列和上下文，保留日志与既有投递证据。 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          for (const table of [...TABLES].reverse())
            await queryInterface.dropTable(table, { transaction });
        } catch (error) {
          throw new Error('AOS_SIGNAL_MIGRATION_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('AOS_SIGNAL_MIGRATION_FAILED', { cause: error });
    }
  },
};
