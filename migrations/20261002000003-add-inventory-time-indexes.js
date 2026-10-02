const INDEXES = [
  ['inventory_samples', 'observedAt'],
  ['inventory_events', 'observedAt'],
  ['inventory_hourly', 'bucket'],
];
module.exports = {
  /** 为分析时间窗口增加表达式索引，避免扫描整个保留期。 */
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          for (const [table, field] of INDEXES) {
            await queryInterface.sequelize.query(
              `CREATE INDEX ${table}_time_idx ON ${table} (((body->>'${field}')::bigint))`,
              { transaction }
            );
          }
        } catch (error) {
          throw new Error('INVENTORY_TIME_INDEX_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('INVENTORY_TIME_INDEX_FAILED', { cause: error });
    }
  },
  /** 回滚索引，保留库存数据。 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          for (const [table] of INDEXES)
            await queryInterface.sequelize.query(`DROP INDEX IF EXISTS ${table}_time_idx`, {
              transaction,
            });
        } catch (error) {
          throw new Error('INVENTORY_TIME_INDEX_ROLLBACK_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('INVENTORY_TIME_INDEX_ROLLBACK_FAILED', { cause: error });
    }
  },
};
