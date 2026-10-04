const logger = require('../src/utils/logger');
/** 自有库存正式迁移：兼容身份回填不代表实物入账。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `CREATE SEQUENCE stock_sale_number_seq;
CREATE TABLE stock_settings (
  id SMALLINT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  cutover_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (id=1),
  CHECK (version>=0)
);
CREATE TABLE stock_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_key VARCHAR(80) NOT NULL,
  model_name VARCHAR(100) NOT NULL,
  storage_gb INTEGER NOT NULL,
  color_key VARCHAR(64) NOT NULL,
  color_name VARCHAR(64) NOT NULL,
  sku_code VARCHAR(64),
  is_active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (storage_gb>0),
  UNIQUE(model_key,storage_gb,color_key),
  CHECK (version>=0)
);
CREATE TABLE stock_parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  party_type VARCHAR(24) NOT NULL,
  roles JSONB NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  contact_ciphertext TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (party_type IN ('internal_person','external_person','business')),
  CHECK (jsonb_typeof(roles)='array' AND jsonb_array_length(roles)>0 AND roles <@ '["customer","salesperson","consignee","handler"]'::jsonb),
  UNIQUE(user_id),
  CHECK (version>=0)
);
CREATE INDEX stock_parties_user_id_idx ON stock_parties(user_id);
CREATE TABLE stock_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  city VARCHAR(50) NOT NULL,
  party_id UUID REFERENCES stock_parties(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind IN ('warehouse','consignee','historical')),
  CHECK ((kind='consignee')=(party_id IS NOT NULL)),
  UNIQUE(name),
  CHECK (version>=0)
);
CREATE INDEX stock_locations_party_id_idx ON stock_locations(party_id);
CREATE TABLE stock_official_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES stock_products(id) ON DELETE RESTRICT,
  valid_from DATE NOT NULL,
  valid_to DATE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount IS NULL OR amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  source_label VARCHAR(200) NOT NULL,
  source_version VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (amount>0),
  CHECK (valid_to IS NULL OR valid_to>valid_from),
  UNIQUE(product_id,valid_from),
  CHECK (version>=0)
);
CREATE INDEX stock_official_prices_product_id_idx ON stock_official_prices(product_id);
CREATE TABLE stock_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_number VARCHAR(12) NOT NULL,
  product_id UUID REFERENCES stock_products(id) ON DELETE RESTRICT,
  state VARCHAR(16) NOT NULL DEFAULT 'registered',
  location_id UUID REFERENCES stock_locations(id) ON DELETE RESTRICT,
  acquired_on DATE,
  first_received_at TIMESTAMPTZ,
  cost_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  official_cost_amount NUMERIC(14,2) CHECK (official_cost_amount IS NULL OR official_cost_amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  price_id UUID REFERENCES stock_official_prices(id) ON DELETE RESTRICT,
  cost_source VARCHAR(16),
  cost_basis_ciphertext TEXT,
  origin_mode VARCHAR(24) NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (serial_number ~ '^[A-Z0-9]{10}([A-Z0-9]{2})?$' AND serial_number ~ '[A-Z]'),
  CHECK (state IN ('registered','in_stock','in_transit','sold')),
  CHECK ((state='in_stock')=(location_id IS NOT NULL)),
  CHECK (state='registered' OR product_id IS NOT NULL),
  CHECK (cost_status IN ('pending','confirmed')),
  CHECK ((cost_status='pending' AND official_cost_amount IS NULL) OR (cost_status='confirmed' AND official_cost_amount IS NOT NULL AND official_cost_amount>0 AND acquired_on IS NOT NULL AND cost_source IS NOT NULL AND cost_source IN ('catalog','manual'))),
  CHECK (origin_mode IN ('legacy_binding','opening','current','history')),
  UNIQUE(serial_number),
  UNIQUE(id,serial_number),
  CHECK (version>=0)
);
CREATE INDEX stock_units_product_id_idx ON stock_units(product_id);
CREATE INDEX stock_units_location_id_idx ON stock_units(location_id);
CREATE INDEX stock_units_price_id_idx ON stock_units(price_id);
CREATE TABLE stock_sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_no VARCHAR(32) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  customer_id UUID REFERENCES stock_parties(id) ON DELETE RESTRICT,
  salesperson_id UUID REFERENCES stock_parties(id) ON DELETE RESTRICT,
  handler_id UUID REFERENCES stock_parties(id) ON DELETE RESTRICT,
  consignee_location_id UUID REFERENCES stock_locations(id) ON DELETE RESTRICT,
  shipped_at TIMESTAMPTZ,
  is_historical BOOLEAN NOT NULL DEFAULT false,
  fees_complete BOOLEAN NOT NULL DEFAULT false,
  notes_ciphertext TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sale_no),
  CHECK (channel IN ('local','consignment')),
  CHECK (status IN ('draft','reserved','shipped','cancelled','voided')),
  CHECK (channel<>'consignment' OR consignee_location_id IS NOT NULL),
  CHECK (status<>'shipped' OR (shipped_at IS NOT NULL AND salesperson_id IS NOT NULL AND handler_id IS NOT NULL)),
  CHECK (version>=0)
);
CREATE INDEX stock_sales_customer_id_idx ON stock_sales(customer_id);
CREATE INDEX stock_sales_salesperson_id_idx ON stock_sales(salesperson_id);
CREATE INDEX stock_sales_handler_id_idx ON stock_sales(handler_id);
CREATE INDEX stock_sales_consignee_location_id_idx ON stock_sales(consignee_location_id);
CREATE TABLE stock_sale_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES stock_sales(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES stock_products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  quoted_unit_amount NUMERIC(14,2) CHECK (quoted_unit_amount IS NULL OR quoted_unit_amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (quantity BETWEEN 1 AND 1000),
  CHECK (quoted_unit_amount IS NULL OR quoted_unit_amount>0),
  UNIQUE(sale_id,product_id),
  CHECK (version>=0)
);
CREATE INDEX stock_sale_lines_sale_id_idx ON stock_sale_lines(sale_id);
CREATE INDEX stock_sale_lines_product_id_idx ON stock_sale_lines(product_id);
CREATE TABLE stock_sale_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_line_id UUID NOT NULL REFERENCES stock_sale_lines(id) ON DELETE RESTRICT,
  stock_unit_id UUID NOT NULL REFERENCES stock_units(id) ON DELETE RESTRICT,
  from_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL,
  sale_amount NUMERIC(14,2) CHECK (sale_amount IS NULL OR sale_amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  cost_amount_snapshot NUMERIC(14,2) CHECK (cost_amount_snapshot IS NULL OR cost_amount_snapshot NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  product_snapshot JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('picked','shipped','released','voided')),
  CHECK (status<>'shipped' OR (sale_amount IS NOT NULL AND sale_amount>0)),
  CHECK (sale_amount IS NULL OR sale_amount>0),
  CHECK (cost_amount_snapshot IS NULL OR cost_amount_snapshot>0),
  CHECK (version>=0)
);
CREATE INDEX stock_sale_units_sale_line_id_idx ON stock_sale_units(sale_line_id);
CREATE INDEX stock_sale_units_stock_unit_id_idx ON stock_sale_units(stock_unit_id);
CREATE INDEX stock_sale_units_from_location_id_idx ON stock_sale_units(from_location_id);
CREATE TABLE stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_location_id UUID REFERENCES stock_locations(id) ON DELETE RESTRICT,
  origin_label VARCHAR(200),
  to_location_id UUID NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  handler_id UUID NOT NULL REFERENCES stock_parties(id) ON DELETE RESTRICT,
  dispatched_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  notes_ciphertext TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('draft','in_transit','partially_received','received','cancelled')),
  CHECK (from_location_id IS NOT NULL OR (origin_label IS NOT NULL AND length(origin_label)>0)),
  CHECK (from_location_id IS NULL OR from_location_id<>to_location_id),
  CHECK (version>=0)
);
CREATE INDEX stock_transfers_from_location_id_idx ON stock_transfers(from_location_id);
CREATE INDEX stock_transfers_to_location_id_idx ON stock_transfers(to_location_id);
CREATE INDEX stock_transfers_handler_id_idx ON stock_transfers(handler_id);
CREATE TABLE stock_transfer_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE RESTRICT,
  stock_unit_id UUID NOT NULL REFERENCES stock_units(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'planned',
  received_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(transfer_id,stock_unit_id),
  CHECK (status IN ('planned','in_transit','received','cancelled')),
  CHECK (version>=0)
);
CREATE INDEX stock_transfer_units_transfer_id_idx ON stock_transfer_units(transfer_id);
CREATE INDEX stock_transfer_units_stock_unit_id_idx ON stock_transfer_units(stock_unit_id);
CREATE TABLE stock_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES stock_sales(id) ON DELETE RESTRICT,
  category VARCHAR(24) NOT NULL,
  scope VARCHAR(24) NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount IS NULL OR amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  occurred_at TIMESTAMPTZ NOT NULL,
  paid_by_party_id UUID REFERENCES stock_parties(id) ON DELETE RESTRICT,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  notes_ciphertext TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (category IN ('shipping','errand','consignment','other')),
  CHECK (scope IN ('all_units','selected_units')),
  CHECK (amount>0),
  CHECK (status IN ('active','voided')),
  CHECK (version>=0)
);
CREATE INDEX stock_expenses_sale_id_idx ON stock_expenses(sale_id);
CREATE INDEX stock_expenses_paid_by_party_id_idx ON stock_expenses(paid_by_party_id);
CREATE TABLE stock_expense_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES stock_expenses(id) ON DELETE RESTRICT,
  expense_version INTEGER NOT NULL,
  sale_unit_id UUID NOT NULL REFERENCES stock_sale_units(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount IS NULL OR amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (amount>=0),
  UNIQUE(expense_id,expense_version,sale_unit_id),
  CHECK (version>=0)
);
CREATE INDEX stock_expense_allocations_expense_id_idx ON stock_expense_allocations(expense_id);
CREATE INDEX stock_expense_allocations_sale_unit_id_idx ON stock_expense_allocations(sale_unit_id);
CREATE TABLE stock_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES stock_sales(id) ON DELETE RESTRICT,
  destination VARCHAR(16) NOT NULL,
  collector_id UUID REFERENCES stock_parties(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount IS NULL OR amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  received_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'posted',
  external_record_key VARCHAR(100),
  notes_ciphertext TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (destination IN ('company','agent')),
  CHECK ((destination='agent')=(collector_id IS NOT NULL)),
  CHECK (amount>0),
  CHECK (status IN ('posted','voided')),
  UNIQUE(external_record_key),
  CHECK (version>=0)
);
CREATE INDEX stock_collections_sale_id_idx ON stock_collections(sale_id);
CREATE INDEX stock_collections_collector_id_idx ON stock_collections(collector_id);
CREATE TABLE stock_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(24) NOT NULL,
  payer_id UUID REFERENCES stock_parties(id) ON DELETE RESTRICT,
  collection_id UUID REFERENCES stock_collections(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount IS NULL OR amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  received_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'posted',
  external_record_key VARCHAR(100),
  notes_ciphertext TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (source IN ('agent_transfer','direct_customer')),
  CHECK ((source='agent_transfer' AND payer_id IS NOT NULL AND collection_id IS NULL) OR (source='direct_customer' AND payer_id IS NULL AND collection_id IS NOT NULL)),
  CHECK (amount>0),
  CHECK (status IN ('posted','voided')),
  UNIQUE(external_record_key),
  CHECK (version>=0)
);
CREATE INDEX stock_receipts_payer_id_idx ON stock_receipts(payer_id);
CREATE INDEX stock_receipts_collection_id_idx ON stock_receipts(collection_id);
CREATE TABLE stock_receipt_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES stock_receipts(id) ON DELETE RESTRICT,
  collection_id UUID NOT NULL REFERENCES stock_collections(id) ON DELETE RESTRICT,
  sale_unit_id UUID NOT NULL REFERENCES stock_sale_units(id) ON DELETE RESTRICT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount IS NULL OR amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (amount>0),
  CHECK (status IN ('active','reversed')),
  CHECK (version>=0)
);
CREATE INDEX stock_receipt_allocations_receipt_id_idx ON stock_receipt_allocations(receipt_id);
CREATE INDEX stock_receipt_allocations_collection_id_idx ON stock_receipt_allocations(collection_id);
CREATE INDEX stock_receipt_allocations_sale_unit_id_idx ON stock_receipt_allocations(sale_unit_id);
CREATE TABLE stock_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind VARCHAR(24) NOT NULL,
  object_key VARCHAR(500) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'prepared',
  expires_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind IN ('unit_photo','sale_document','collection_proof','receipt_proof','expense_proof')),
  CHECK (status IN ('prepared','confirmed')),
  CHECK (size_bytes BETWEEN 1 AND 10485760),
  UNIQUE(object_key),
  CHECK (version>=0)
);
CREATE TABLE stock_attachment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id UUID NOT NULL REFERENCES stock_attachments(id) ON DELETE RESTRICT,
  unit_id UUID REFERENCES stock_units(id) ON DELETE RESTRICT,
  sale_id UUID REFERENCES stock_sales(id) ON DELETE RESTRICT,
  collection_id UUID REFERENCES stock_collections(id) ON DELETE RESTRICT,
  receipt_id UUID REFERENCES stock_receipts(id) ON DELETE RESTRICT,
  expense_id UUID REFERENCES stock_expenses(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (num_nonnulls(unit_id,sale_id,collection_id,receipt_id,expense_id)=1),
  CHECK (version>=0)
);
CREATE INDEX stock_attachment_links_attachment_id_idx ON stock_attachment_links(attachment_id);
CREATE INDEX stock_attachment_links_unit_id_idx ON stock_attachment_links(unit_id);
CREATE INDEX stock_attachment_links_sale_id_idx ON stock_attachment_links(sale_id);
CREATE INDEX stock_attachment_links_collection_id_idx ON stock_attachment_links(collection_id);
CREATE INDEX stock_attachment_links_receipt_id_idx ON stock_attachment_links(receipt_id);
CREATE INDEX stock_attachment_links_expense_id_idx ON stock_attachment_links(expense_id);
CREATE TABLE stock_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_key VARCHAR(40) NOT NULL,
  request_key UUID NOT NULL,
  action VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  result_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(actor_key,request_key)
);
CREATE INDEX stock_operations_actor_user_id_idx ON stock_operations(actor_user_id);
CREATE TABLE stock_events (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(40) NOT NULL,
  entity_id UUID NOT NULL,
  action VARCHAR(64) NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name VARCHAR(100) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  before_version INTEGER,
  after_version INTEGER NOT NULL,
  changes_ciphertext JSONB NOT NULL,
  operation_id UUID NOT NULL REFERENCES stock_operations(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX stock_events_actor_user_id_idx ON stock_events(actor_user_id);
CREATE INDEX stock_events_operation_id_idx ON stock_events(operation_id);
CREATE TABLE stock_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind VARCHAR(24) NOT NULL,
  file_hash CHAR(64) NOT NULL,
  preview_hash CHAR(64) NOT NULL,
  source_label VARCHAR(100) NOT NULL,
  payload_ciphertext JSONB NOT NULL,
  result_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'preview',
  expires_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind IN ('opening','historical_sales','collections','receipts')),
  CHECK (status IN ('preview','committed','expired')),
  CHECK (version>=0)
);
CREATE UNIQUE INDEX stock_locations_historical_one ON stock_locations(kind) WHERE kind='historical';
CREATE UNIQUE INDEX stock_sale_units_active_unit ON stock_sale_units(stock_unit_id) WHERE status IN ('picked','shipped');
CREATE UNIQUE INDEX stock_transfer_units_active_unit ON stock_transfer_units(stock_unit_id) WHERE status='in_transit';
CREATE UNIQUE INDEX stock_collections_posted_sale ON stock_collections(sale_id) WHERE status='posted';
CREATE UNIQUE INDEX stock_receipts_direct_collection ON stock_receipts(collection_id) WHERE status='posted' AND source='direct_customer';
CREATE UNIQUE INDEX stock_receipt_allocations_active_unit ON stock_receipt_allocations(receipt_id,sale_unit_id) WHERE status='active';
CREATE INDEX stock_units_state_product_location ON stock_units(product_id,state,location_id);
CREATE INDEX stock_sales_status_channel ON stock_sales(status,channel,created_at);
CREATE INDEX stock_sales_ship_person ON stock_sales(shipped_at,salesperson_id);
CREATE INDEX stock_events_entity_time ON stock_events(entity_type,entity_id,created_at);
INSERT INTO stock_settings(id) VALUES(1);
INSERT INTO stock_locations(name,kind,city,is_active) VALUES('历史出货地点待核实','historical','未核实',false);
ALTER TABLE pickup_devices ADD COLUMN stock_unit_id UUID NULL UNIQUE;
INSERT INTO stock_units(serial_number,origin_mode,created_at,updated_at) SELECT serial_number,'legacy_binding',created_at,created_at FROM pickup_devices;
UPDATE pickup_devices p SET stock_unit_id=u.id FROM stock_units u WHERE p.serial_number=u.serial_number;
ALTER TABLE pickup_devices ADD CONSTRAINT pickup_devices_stock_unit_sn_fk FOREIGN KEY(stock_unit_id,serial_number) REFERENCES stock_units(id,serial_number) ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE UNIQUE INDEX stock_attachment_links_unit_id_unique ON stock_attachment_links(attachment_id,unit_id) WHERE unit_id IS NOT NULL;
CREATE UNIQUE INDEX stock_attachment_links_sale_id_unique ON stock_attachment_links(attachment_id,sale_id) WHERE sale_id IS NOT NULL;
CREATE UNIQUE INDEX stock_attachment_links_collection_id_unique ON stock_attachment_links(attachment_id,collection_id) WHERE collection_id IS NOT NULL;
CREATE UNIQUE INDEX stock_attachment_links_receipt_id_unique ON stock_attachment_links(attachment_id,receipt_id) WHERE receipt_id IS NOT NULL;
CREATE UNIQUE INDEX stock_attachment_links_expense_id_unique ON stock_attachment_links(attachment_id,expense_id) WHERE expense_id IS NOT NULL;`,
          { transaction }
        );
      });
    } catch (error) {
      logger.debug('库存处理未完成', {
        module: '20261004000001-create-stock-management',
        code: error.code || error.name,
      });
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
          `SELECT
          (SELECT count(*) FROM stock_units WHERE origin_mode<>'legacy_binding' OR state<>'registered') +
          (SELECT count(*) FROM stock_sales) + (SELECT count(*) FROM stock_transfers) +
          (SELECT count(*) FROM stock_events) + (SELECT count(*) FROM stock_attachments) +
          (SELECT count(*) FROM stock_import_jobs WHERE status='committed') AS total`,
          { transaction }
        );
        if (Number(rows[0].total))
          throw new Error('存在库存业务或审计数据，拒绝删除；请保留 schema 回滚应用');
        await queryInterface.sequelize.query(
          `ALTER TABLE pickup_devices DROP CONSTRAINT pickup_devices_stock_unit_sn_fk;
ALTER TABLE pickup_devices DROP COLUMN stock_unit_id;
DROP TABLE stock_import_jobs;
DROP TABLE stock_events;
DROP TABLE stock_operations;
DROP TABLE stock_attachment_links;
DROP TABLE stock_attachments;
DROP TABLE stock_receipt_allocations;
DROP TABLE stock_receipts;
DROP TABLE stock_collections;
DROP TABLE stock_expense_allocations;
DROP TABLE stock_expenses;
DROP TABLE stock_transfer_units;
DROP TABLE stock_transfers;
DROP TABLE stock_sale_units;
DROP TABLE stock_sale_lines;
DROP TABLE stock_sales;
DROP TABLE stock_units;
DROP TABLE stock_official_prices;
DROP TABLE stock_locations;
DROP TABLE stock_parties;
DROP TABLE stock_products;
DROP TABLE stock_settings;
DROP SEQUENCE stock_sale_number_seq;`,
          { transaction }
        );
      });
    } catch (error) {
      logger.debug('库存处理未完成', {
        module: '20261004000001-create-stock-management',
        code: error.code || error.name,
      });
      throw error;
    }
  },
};
