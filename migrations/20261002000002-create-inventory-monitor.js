const TABLES = [
  'inventory_products',
  'inventory_stores',
  'inventory_settings',
  'inventory_runtime',
  'inventory_rounds',
  'inventory_snapshots',
  'inventory_samples',
  'inventory_events',
  'inventory_hourly',
  'inventory_deliveries',
];

module.exports = {
  /** 创建库存独立表及索引。 */
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
            await queryInterface.addIndex(table, ['created_at'], { transaction });
            await queryInterface.addIndex(table, ['body'], { using: 'gin', transaction });
          }
          await queryInterface.sequelize.query(
            "CREATE INDEX inventory_rounds_status_idx ON inventory_rounds ((body->>'status'), created_at)",
            { transaction }
          );
          await queryInterface.sequelize.query(
            "CREATE INDEX inventory_deliveries_status_idx ON inventory_deliveries ((body->>'status'), created_at)",
            { transaction }
          );
          for (const table of ['inventory_samples', 'inventory_events', 'inventory_snapshots']) {
            await queryInterface.sequelize.query(
              `CREATE INDEX ${table}_scope_idx ON ${table} ((body->>'sku'), (body->>'storeCode'), created_at)`,
              { transaction }
            );
          }
          await queryInterface.bulkInsert(
            'inventory_settings',
            [{ id: 'main', body: JSON.stringify({ version: 1, config: {} }) }],
            { transaction }
          );
          await queryInterface.bulkInsert(
            'inventory_runtime',
            [{ id: 'main', body: JSON.stringify({}) }],
            { transaction }
          );
        } catch (error) {
          throw new Error('INVENTORY_MIGRATION_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('INVENTORY_MIGRATION_FAILED', { cause: error });
    }
  },
  /** 按依赖反向回滚，不触及验证证据及订单表。 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          for (const table of [...TABLES].reverse())
            await queryInterface.dropTable(table, { transaction });
        } catch (error) {
          throw new Error('INVENTORY_MIGRATION_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('INVENTORY_MIGRATION_FAILED', { cause: error });
    }
  },
};
