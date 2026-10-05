const logger = require('../src/utils/logger');

/** 人工结算只增量扩展，不推算或回填历史资金。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          ALTER TABLE stock_sale_units ADD COLUMN settlement_amount NUMERIC(14,2);
          ALTER TABLE stock_sale_units ADD CONSTRAINT stock_sale_units_settlement_check CHECK (
            settlement_amount IS NULL OR (settlement_amount >= 0 AND
              settlement_amount <> 'NaN'::numeric AND sale_amount IS NOT NULL AND settlement_amount <= sale_amount));
        `,
          { transaction }
        );
      });
    } catch (error) {
      logger.warn('库存结算迁移失败', { code: error.code || error.name });
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        const [rows] = await queryInterface.sequelize.query(
          'SELECT 1 FROM stock_sale_units WHERE settlement_amount IS NOT NULL LIMIT 1',
          { transaction }
        );
        if (rows.length) throw new Error('已有结算业务资料，拒绝删除；请保留结构回滚应用');
        await queryInterface.removeColumn('stock_sale_units', 'settlement_amount', { transaction });
      });
    } catch (error) {
      logger.warn('库存结算回退失败', { code: error.code || error.name });
      throw error;
    }
  },
};
