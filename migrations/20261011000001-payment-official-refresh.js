/** 付款核对复用官网队列，保留全部任务审计。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.query(`ALTER TABLE official_order_refresh_batches
        DROP CONSTRAINT official_refresh_purpose,
        ADD CONSTRAINT official_refresh_purpose CHECK
        ((purpose IN ('manual','payment_manual') AND requested_by IS NOT NULL)
        OR (purpose IN ('stock_returns','payment_auto') AND requested_by IS NULL))`);
    } catch (error) {
      throw new Error('付款官网刷新迁移失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.sequelize.query(
            `DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM official_order_refresh_batches
              WHERE purpose IN ('payment_manual','payment_auto'))
            THEN RAISE EXCEPTION '保留付款刷新审计，请仅回滚应用'; END IF;
            END $$;
            ALTER TABLE official_order_refresh_batches DROP CONSTRAINT official_refresh_purpose,
            ADD CONSTRAINT official_refresh_purpose CHECK
            ((purpose='manual' AND requested_by IS NOT NULL)
            OR (purpose='stock_returns' AND requested_by IS NULL))`,
            { transaction }
          );
        } catch (error) {
          throw new Error('付款官网刷新回滚被保护', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('付款官网刷新回滚失败', { cause: error });
    }
  },
};
