/** 复用官网观测列并新增人工队列；保留原观测，不恢复退役爬虫。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          ALTER TABLE orders ALTER COLUMN official_raw_status TYPE TEXT;
          CREATE TABLE official_order_refresh_batches (
            id UUID PRIMARY KEY, requested_by INTEGER NOT NULL REFERENCES users(id),
            request_key UUID NOT NULL, request_fingerprint VARCHAR(64) NOT NULL,
            selection_mode VARCHAR(10) NOT NULL CHECK (selection_mode IN ('ids','filtered')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (requested_by, request_key)
          );
          CREATE TABLE official_order_refresh_jobs (
            id UUID PRIMARY KEY,
            batch_id UUID NOT NULL REFERENCES official_order_refresh_batches(id),
            order_id INTEGER NOT NULL REFERENCES orders(id), order_number VARCHAR(20) NOT NULL,
            state VARCHAR(12) NOT NULL DEFAULT 'queued'
              CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
            error_code VARCHAR(80), lease_token UUID, started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            result_run_id INTEGER, result_sha256 VARCHAR(64), previous_status TEXT,
            result_status TEXT, observed_at TIMESTAMPTZ,
            UNIQUE (batch_id, order_id)
          );
          CREATE UNIQUE INDEX official_refresh_active_order
            ON official_order_refresh_jobs(order_id) WHERE state IN ('queued','running');
          CREATE INDEX official_refresh_batch_jobs ON official_order_refresh_jobs(batch_id,created_at,id);
          CREATE INDEX official_refresh_queue ON official_order_refresh_jobs(created_at,id)
            WHERE state='queued';
          CREATE TABLE official_order_refresh_runtime (
            id INTEGER PRIMARY KEY CHECK (id=1), heartbeat_at TIMESTAMPTZ NOT NULL
          );
        `,
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('手动官网更新迁移失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM official_order_refresh_batches)
              OR EXISTS (SELECT 1 FROM orders WHERE length(official_raw_status)>100) THEN
              RAISE EXCEPTION '保留官网观测与审计，请仅回滚应用';
            END IF;
          END $$;
          DROP TABLE official_order_refresh_runtime, official_order_refresh_jobs,
            official_order_refresh_batches;
          ALTER TABLE orders ALTER COLUMN official_raw_status TYPE VARCHAR(100);
        `,
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('手动官网更新迁移回滚失败', { cause: error });
    }
  },
};
