'use strict';

module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          ALTER TABLE proxy_orders ADD COLUMN deleted_at TIMESTAMPTZ;
          CREATE INDEX proxy_orders_visible_id ON proxy_orders(id) WHERE deleted_at IS NULL;
        `,
          { transaction }
        );
      });
    } catch (error) {
      error.migration = '20261016000001-soft-delete-proxy-orders';
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          LOCK TABLE proxy_orders IN ACCESS EXCLUSIVE MODE;
          DO $$ BEGIN
            IF EXISTS(SELECT 1 FROM proxy_orders WHERE deleted_at IS NOT NULL)
            THEN RAISE EXCEPTION '已有软删除历史，禁止有损回退'; END IF;
          END $$;
          DROP INDEX proxy_orders_visible_id;
          ALTER TABLE proxy_orders DROP COLUMN deleted_at;
        `,
          { transaction }
        );
      });
    } catch (error) {
      error.migration = '20261016000001-soft-delete-proxy-orders';
      throw error;
    }
  },
};
