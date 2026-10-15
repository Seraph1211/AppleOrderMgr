'use strict';

module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          ALTER TABLE proxy_orders DROP CONSTRAINT IF EXISTS proxy_orders_platform_order_number_key;
          ALTER TABLE proxy_orders ADD COLUMN order_source VARCHAR(100),
            ADD COLUMN product_candidates JSONB NOT NULL DEFAULT '[]';
          UPDATE proxy_orders SET product_candidates=jsonb_build_array(jsonb_build_object(
            'productModel',product_model,'color',color,'storage',storage));
          ALTER TABLE proxy_orders ADD CONSTRAINT proxy_candidates_array CHECK (
            jsonb_typeof(product_candidates)='array' AND jsonb_array_length(product_candidates)>0);
          CREATE TABLE proxy_order_links (
            id SERIAL PRIMARY KEY,
            proxy_order_id INTEGER NOT NULL REFERENCES proxy_orders(id) ON DELETE RESTRICT,
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
            source VARCHAR(20) NOT NULL,
            actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            unlinked_at TIMESTAMPTZ,
            reason_encrypted TEXT,
            CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at)
          );
          CREATE UNIQUE INDEX proxy_order_link_active ON proxy_order_links(order_id) WHERE unlinked_at IS NULL;
          CREATE INDEX proxy_order_links_request ON proxy_order_links(proxy_order_id,id);
          INSERT INTO proxy_order_links(proxy_order_id,order_id,source,linked_at)
            SELECT id,order_id,'legacy',updated_at FROM proxy_orders WHERE order_id IS NOT NULL;
          INSERT INTO user_permissions(user_id,permission_code,created_at,updated_at)
            SELECT DISTINCT user_id,'proxy_orders.read',NOW(),NOW() FROM user_permissions
            WHERE permission_code IN ('proxy_orders.edit','proxy_orders.status','proxy_orders.copy','proxy_orders.accounts','proxy_orders.link')
            ON CONFLICT DO NOTHING;
        `,
          { transaction }
        );
      });
    } catch (error) {
      error.migration = '20261015000003-proxy-orders-v2';
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          DO $$ BEGIN
            IF EXISTS(SELECT 1 FROM proxy_orders WHERE order_source IS NOT NULL OR jsonb_array_length(product_candidates)<>1)
              OR EXISTS(SELECT 1 FROM proxy_order_links WHERE source<>'legacy' OR unlinked_at IS NOT NULL)
              OR EXISTS(SELECT platform_order_number FROM proxy_orders WHERE platform_order_number IS NOT NULL GROUP BY platform_order_number HAVING COUNT(*)>1)
            THEN RAISE EXCEPTION '二期业务数据无法无损回退，禁止删除历史'; END IF;
          END $$;
          DROP TABLE proxy_order_links;
          ALTER TABLE proxy_orders DROP COLUMN order_source, DROP COLUMN product_candidates;
          ALTER TABLE proxy_orders ADD CONSTRAINT proxy_orders_platform_order_number_key UNIQUE(platform_order_number);
        `,
          { transaction }
        );
      });
    } catch (error) {
      error.migration = '20261015000003-proxy-orders-v2';
      throw error;
    }
  },
};
