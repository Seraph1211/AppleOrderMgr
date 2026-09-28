'use strict';

module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          ALTER TABLE apple_ids ADD COLUMN is_proxy_pool BOOLEAN NOT NULL DEFAULT false;
          CREATE TABLE proxy_orders (
            id SERIAL PRIMARY KEY,
            platform_order_number VARCHAR(100) UNIQUE,
            last_name VARCHAR(50) NOT NULL, first_name VARCHAR(50) NOT NULL,
            phone VARCHAR(20) NOT NULL, email VARCHAR(255) NOT NULL,
            id_last4 VARCHAR(4) NOT NULL CHECK (id_last4 ~ '^[0-9]{3}[0-9Xx]$'),
            product_model VARCHAR(100) NOT NULL, color VARCHAR(100) NOT NULL,
            storage VARCHAR(20) NOT NULL, quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
            store_codes JSONB NOT NULL CHECK (jsonb_typeof(store_codes)='array' AND jsonb_array_length(store_codes)>0),
            store_mode VARCHAR(20) NOT NULL CHECK (store_mode IN ('selected','city_any')),
            store_city VARCHAR(100), billing JSONB NOT NULL,
            payment_method VARCHAR(50), notes TEXT, raw_text TEXT,
            status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rushing','succeeded','cancelled')),
            order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
            anomaly TEXT, rejected_order_ids JSONB NOT NULL DEFAULT '[]',
            version INTEGER NOT NULL DEFAULT 1,
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX proxy_orders_status_id ON proxy_orders(status,id);
          CREATE TABLE proxy_assignments (
            id SERIAL PRIMARY KEY,
            proxy_order_id INTEGER NOT NULL REFERENCES proxy_orders(id) ON DELETE RESTRICT,
            apple_id_ref INTEGER NOT NULL REFERENCES apple_ids(id) ON DELETE RESTRICT,
            account_email VARCHAR(255) NOT NULL,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ended_at TIMESTAMPTZ,
            CHECK (ended_at IS NULL OR ended_at >= started_at)
          );
          CREATE UNIQUE INDEX proxy_account_active ON proxy_assignments(apple_id_ref) WHERE ended_at IS NULL;
          CREATE INDEX proxy_assignments_order ON proxy_assignments(proxy_order_id);
          CREATE TABLE proxy_events (
            id SERIAL PRIMARY KEY, proxy_order_id INTEGER REFERENCES proxy_orders(id) ON DELETE RESTRICT,
            actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            action VARCHAR(60) NOT NULL, detail JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX proxy_events_order ON proxy_events(proxy_order_id,id);
          CREATE FUNCTION guard_proxy_pool_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
          BEGIN
            PERFORM pg_advisory_xact_lock(17092026);
            IF TG_TABLE_NAME='recipients' THEN
              IF NEW.apple_id_ref IS NOT NULL AND EXISTS(SELECT 1 FROM apple_ids WHERE id=NEW.apple_id_ref AND is_proxy_pool) THEN
                RAISE EXCEPTION '代抢专用账号不可绑定普通取机人' USING ERRCODE='23514';
              END IF;
            ELSE
              IF NEW.is_proxy_pool AND EXISTS(SELECT 1 FROM recipients WHERE apple_id_ref=NEW.id) THEN
                RAISE EXCEPTION '已绑定普通取机人的账号不能纳入代抢池' USING ERRCODE='23514';
              END IF;
              IF NOT NEW.is_proxy_pool AND EXISTS(SELECT 1 FROM proxy_assignments WHERE apple_id_ref=NEW.id AND ended_at IS NULL) THEN
                RAISE EXCEPTION '占用账号不能移出代抢池' USING ERRCODE='23514';
              END IF;
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER guard_proxy_recipient BEFORE INSERT OR UPDATE OF apple_id_ref ON recipients
            FOR EACH ROW EXECUTE FUNCTION guard_proxy_pool_binding();
          CREATE TRIGGER guard_proxy_account BEFORE UPDATE OF is_proxy_pool ON apple_ids
            FOR EACH ROW EXECUTE FUNCTION guard_proxy_pool_binding();
        `,
          { transaction }
        );
      });
    } catch (error) {
      error.migration = '20260928000002-add-proxy-orders';
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          DO $$ BEGIN
            IF EXISTS(SELECT 1 FROM proxy_orders) OR EXISTS(SELECT 1 FROM apple_ids WHERE is_proxy_pool)
            THEN RAISE EXCEPTION '已有代抢业务数据，禁止回退删除'; END IF;
          END $$;
          DROP TRIGGER guard_proxy_recipient ON recipients;
          DROP TRIGGER guard_proxy_account ON apple_ids;
          DROP FUNCTION guard_proxy_pool_binding();
          DROP TABLE proxy_events, proxy_assignments, proxy_orders;
          ALTER TABLE apple_ids DROP COLUMN is_proxy_pool;
        `,
          { transaction }
        );
      });
    } catch (error) {
      error.migration = '20260928000002-add-proxy-orders';
      throw error;
    }
  },
};
