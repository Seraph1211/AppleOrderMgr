const logger = require('../src/utils/logger');

/** 保存金额待补的代收事实，不创建虚构收款金额。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          ALTER TABLE stock_sales
            ADD COLUMN pending_collector_id UUID REFERENCES stock_parties(id) ON DELETE RESTRICT,
            ADD COLUMN pending_collected_at TIMESTAMPTZ,
            ADD CONSTRAINT stock_sales_pending_collection_check CHECK
              (pending_collected_at IS NULL OR pending_collector_id IS NOT NULL);
          CREATE INDEX stock_sales_pending_collector_idx ON stock_sales(pending_collector_id);
        `,
          { transaction }
        );
      });
    } catch (error) {
      logger.warn('待补代收迁移失败', { code: error.code || error.name });
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query('LOCK TABLE stock_sales IN ACCESS EXCLUSIVE MODE', {
          transaction,
        });
        const [rows] = await queryInterface.sequelize.query(
          'SELECT 1 FROM stock_sales WHERE pending_collector_id IS NOT NULL LIMIT 1',
          { transaction }
        );
        if (rows.length) throw new Error('已有待补代收事实，拒绝删除；请保留结构回滚应用');
        await queryInterface.sequelize.query(
          `
          ALTER TABLE stock_sales DROP CONSTRAINT stock_sales_pending_collection_check,
            DROP COLUMN pending_collected_at, DROP COLUMN pending_collector_id;
        `,
          { transaction }
        );
      });
    } catch (error) {
      logger.warn('待补代收回退失败', { code: error.code || error.name });
      throw error;
    }
  },
};
