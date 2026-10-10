/** 单台生命周期与全历史退货检查；保留原业务字段及审计。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          DO $$ DECLARE c record; BEGIN
            FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid='stock_units'::regclass AND contype='c'
              AND (pg_get_constraintdef(oid) LIKE '%state%registered%in_stock%'
                OR pg_get_constraintdef(oid) LIKE '%state%registered%product_id%')
            LOOP EXECUTE format('ALTER TABLE stock_units DROP CONSTRAINT %I', c.conname); END LOOP;
          END $$;
          ALTER TABLE stock_units
            ADD COLUMN returned_at timestamptz,
            ADD COLUMN return_previous_state varchar(16),
            ADD COLUMN return_location_id uuid REFERENCES stock_locations(id) ON DELETE RESTRICT,
            ADD COLUMN lifecycle_issue varchar(40),
            ADD COLUMN return_decision_fingerprint varchar(64),
            ADD CONSTRAINT stock_lifecycle_state CHECK (state IN ('registered','in_stock','sold','returned','in_transit')),
            ADD CONSTRAINT stock_lifecycle_product CHECK (state IN ('registered','returned') OR product_id IS NOT NULL),
            ADD CONSTRAINT stock_lifecycle_return CHECK (state<>'returned' OR
              (returned_at IS NOT NULL AND return_previous_state IS NOT NULL AND return_previous_state IN ('registered','in_stock')));
          CREATE INDEX stock_units_return_location ON stock_units(return_location_id);
          CREATE TABLE stock_order_checks (
            order_id integer PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
            items jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items)='array'),
            fingerprint varchar(64), manual_serials jsonb,
            observed_at timestamptz, checked_at timestamptz, last_enqueued_at timestamptz,
            error_code varchar(80), pickup_verified boolean NOT NULL DEFAULT false
          );
          ALTER TABLE official_order_refresh_batches
            ALTER COLUMN requested_by DROP NOT NULL,
            ADD COLUMN purpose varchar(20) NOT NULL DEFAULT 'manual',
            ADD CONSTRAINT official_refresh_purpose CHECK
              ((purpose='manual' AND requested_by IS NOT NULL) OR (purpose='stock_returns' AND requested_by IS NULL));
        `,
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('库存生命周期迁移失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM stock_order_checks)
              OR EXISTS (SELECT 1 FROM stock_units WHERE returned_at IS NOT NULL OR lifecycle_issue IS NOT NULL OR return_decision_fingerprint IS NOT NULL)
              OR EXISTS (SELECT 1 FROM official_order_refresh_batches WHERE purpose='stock_returns')
              OR EXISTS (SELECT 1 FROM stock_events WHERE action LIKE 'lifecycle.%')
            THEN RAISE EXCEPTION '保留生命周期证据，请仅回滚应用'; END IF;
          END $$;
          ALTER TABLE official_order_refresh_batches DROP CONSTRAINT official_refresh_purpose,
            DROP COLUMN purpose, ALTER COLUMN requested_by SET NOT NULL;
          DROP TABLE stock_order_checks;
          ALTER TABLE stock_units DROP CONSTRAINT stock_lifecycle_state,
            DROP CONSTRAINT stock_lifecycle_product, DROP CONSTRAINT stock_lifecycle_return,
            DROP COLUMN returned_at, DROP COLUMN return_previous_state, DROP COLUMN return_location_id,
            DROP COLUMN lifecycle_issue, DROP COLUMN return_decision_fingerprint,
            ADD CHECK (state IN ('registered','in_stock','sold','in_transit')),
            ADD CHECK (state='registered' OR product_id IS NOT NULL);
        `,
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('库存生命周期回退被拒绝', { cause: error });
    }
  },
};
