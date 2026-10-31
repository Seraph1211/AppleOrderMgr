'use strict';

module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `ALTER TABLE proxy_orders
             ADD COLUMN proxy_fee NUMERIC(12,2),
             ADD CONSTRAINT proxy_orders_proxy_fee_check
               CHECK (proxy_fee IS NULL OR proxy_fee BETWEEN 0 AND 9999999999.99);`,
          { transaction }
        );
      });
    } catch (error) {
      error.migration = '20261031000001-add-proxy-order-fee';
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `LOCK TABLE proxy_orders IN ACCESS EXCLUSIVE MODE;
           DO $$ BEGIN
             IF EXISTS(SELECT 1 FROM proxy_orders WHERE proxy_fee IS NOT NULL)
             THEN RAISE EXCEPTION '已有委托费用，禁止有损回退'; END IF;
           END $$;
           ALTER TABLE proxy_orders DROP CONSTRAINT proxy_orders_proxy_fee_check,
             DROP COLUMN proxy_fee;`,
          { transaction }
        );
      });
    } catch (error) {
      error.migration = '20261031000001-add-proxy-order-fee';
      throw error;
    }
  },
};
