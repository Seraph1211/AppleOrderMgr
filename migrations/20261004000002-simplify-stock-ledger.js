'use strict';
const logger = require('../src/utils/logger');

/** 增量支持单台台账，保留原完整版本的实物与资金事实。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `SELECT pg_advisory_xact_lock(641004,1);
          ALTER TABLE stock_units ADD COLUMN order_number_text VARCHAR(100),
            ADD COLUMN notes_ciphertext TEXT,
            ADD COLUMN extra_expense_amount NUMERIC(14,2)
              CHECK (extra_expense_amount IS NULL OR
                (extra_expense_amount >= 0 AND extra_expense_amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)));
          ALTER TABLE stock_sales ADD COLUMN simple_ledger BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN payment_verification VARCHAR(16) NOT NULL DEFAULT 'known'
              CHECK (payment_verification IN ('known','unknown')),
            ADD CONSTRAINT stock_sales_unknown_history_check
              CHECK (payment_verification <> 'unknown' OR (simple_ledger AND is_historical));
          ALTER TABLE stock_sale_units ALTER COLUMN from_location_id DROP NOT NULL;
          ALTER TABLE stock_collections ALTER COLUMN received_at DROP NOT NULL;
          ALTER TABLE stock_receipts ALTER COLUMN received_at DROP NOT NULL;
          DO $$ DECLARE constraint_row record; BEGIN
            FOR constraint_row IN SELECT conname FROM pg_constraint
              WHERE conrelid='stock_units'::regclass AND contype='c'
              AND pg_get_constraintdef(oid) LIKE '%official_cost_amount%acquired_on%'
            LOOP EXECUTE format('ALTER TABLE stock_units DROP CONSTRAINT %I', constraint_row.conname); END LOOP;
            FOR constraint_row IN SELECT conname FROM pg_constraint
              WHERE conrelid='stock_sales'::regclass AND contype='c'
              AND pg_get_constraintdef(oid) LIKE '%salesperson_id%handler_id%'
            LOOP EXECUTE format('ALTER TABLE stock_sales DROP CONSTRAINT %I', constraint_row.conname); END LOOP;
          END $$;
          ALTER TABLE stock_units ADD CONSTRAINT stock_units_cost_snapshot_v2_check CHECK (
            (cost_status='pending' AND official_cost_amount IS NULL) OR
            (cost_status='confirmed' AND official_cost_amount IS NOT NULL AND official_cost_amount>0
              AND cost_source IS NOT NULL AND cost_source IN ('catalog','manual')
              AND (cost_source='manual' OR acquired_on IS NOT NULL)));
          ALTER TABLE stock_sales ADD CONSTRAINT stock_sales_shipped_people_v2_check CHECK (
            status<>'shipped' OR (shipped_at IS NOT NULL AND
              ((simple_ledger AND is_historical) OR (salesperson_id IS NOT NULL AND handler_id IS NOT NULL))));
          CREATE INDEX stock_units_order_number_text_idx ON stock_units(order_number_text);
          CREATE INDEX stock_sales_simple_ledger_idx ON stock_sales(simple_ledger);`,
          { transaction }
        );
      });
    } catch (error) {
      logger.warn('简化库存迁移未完成', { code: error.code || error.name });
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query('SELECT pg_advisory_xact_lock(641004,1)', {
          transaction,
        });
        const [rows] = await queryInterface.sequelize.query(
          `SELECT 1 FROM stock_units WHERE order_number_text IS NOT NULL OR notes_ciphertext IS NOT NULL
            OR extra_expense_amount IS NOT NULL OR (cost_status='confirmed' AND acquired_on IS NULL)
          UNION ALL SELECT 1 FROM stock_sales WHERE simple_ledger OR payment_verification<>'known'
          UNION ALL SELECT 1 FROM stock_sale_units WHERE from_location_id IS NULL
          UNION ALL SELECT 1 FROM stock_collections WHERE received_at IS NULL
          UNION ALL SELECT 1 FROM stock_receipts WHERE received_at IS NULL LIMIT 1`,
          { transaction }
        );
        if (rows.length) throw new Error('简化台账已有业务资料，禁止删除字段；请保留结构回滚应用');
        await queryInterface.sequelize.query(
          `ALTER TABLE stock_units DROP CONSTRAINT stock_units_cost_snapshot_v2_check;
          ALTER TABLE stock_sales DROP CONSTRAINT stock_sales_shipped_people_v2_check;
          ALTER TABLE stock_sales DROP CONSTRAINT stock_sales_unknown_history_check;
          ALTER TABLE stock_units DROP COLUMN order_number_text, DROP COLUMN notes_ciphertext, DROP COLUMN extra_expense_amount;
          ALTER TABLE stock_sales DROP COLUMN simple_ledger, DROP COLUMN payment_verification;
          ALTER TABLE stock_sale_units ALTER COLUMN from_location_id SET NOT NULL;
          ALTER TABLE stock_collections ALTER COLUMN received_at SET NOT NULL;
          ALTER TABLE stock_receipts ALTER COLUMN received_at SET NOT NULL;
          ALTER TABLE stock_units ADD CONSTRAINT stock_units_cost_snapshot_check CHECK (
            (cost_status='pending' AND official_cost_amount IS NULL) OR
            (cost_status='confirmed' AND official_cost_amount IS NOT NULL AND official_cost_amount>0
              AND acquired_on IS NOT NULL AND cost_source IS NOT NULL AND cost_source IN ('catalog','manual')));
          ALTER TABLE stock_sales ADD CONSTRAINT stock_sales_shipped_people_check CHECK (
            status<>'shipped' OR (shipped_at IS NOT NULL AND salesperson_id IS NOT NULL AND handler_id IS NOT NULL));`,
          { transaction }
        );
      });
    } catch (error) {
      logger.warn('简化库存迁移未完成', { code: error.code || error.name });
      throw error;
    }
  },
};
