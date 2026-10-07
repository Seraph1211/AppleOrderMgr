'use strict';
const logger = require('../src/utils/logger');

/** 并行建立压缩日志、全局幂等回执与日目录；不变更旧字段或迁移旧数据。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.sequelize.query(
            `
            CREATE TABLE monitor_log_storage_scopes (
              device_id uuid NOT NULL REFERENCES aos_devices(id) ON DELETE CASCADE,
              local_id uuid NOT NULL, mode text NOT NULL DEFAULT 'rows'
                CHECK (mode IN ('rows','shadow','blocks')),
              generation integer NOT NULL DEFAULT 0, verified_at timestamptz,
              updated_at timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (device_id,local_id));
            CREATE TABLE monitor_log_files (
              id bigserial PRIMARY KEY,
              device_id uuid NOT NULL REFERENCES aos_devices(id) ON DELETE CASCADE,
              file_id uuid NOT NULL, UNIQUE(device_id,file_id));
            CREATE SEQUENCE monitor_log_block_id_seq;
            CREATE TABLE monitor_log_blocks (
              business_date date NOT NULL,
              id bigint NOT NULL DEFAULT nextval('monitor_log_block_id_seq'),
              device_id uuid NOT NULL REFERENCES aos_devices(id) ON DELETE CASCADE,
              local_id uuid NOT NULL, file_key bigint NOT NULL REFERENCES monitor_log_files(id) ON DELETE CASCADE,
              file_name varchar(255) NOT NULL, format_version smallint NOT NULL DEFAULT 1,
              codec text NOT NULL CHECK(codec='gzip'), payload bytea NOT NULL,
              payload_hash bytea NOT NULL, signature bit(8192) NOT NULL,
              entry_count integer NOT NULL CHECK(entry_count>0), raw_bytes integer NOT NULL,
              min_sort_at timestamptz NOT NULL, min_file_id uuid NOT NULL,
              min_byte_offset bigint NOT NULL, max_sort_at timestamptz NOT NULL,
              max_file_id uuid NOT NULL, max_byte_offset bigint NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY(business_date,id)) PARTITION BY RANGE(business_date);
            CREATE INDEX monitor_log_blocks_page ON monitor_log_blocks
              (device_id,local_id,business_date,min_sort_at,min_file_id,min_byte_offset);
            CREATE INDEX monitor_log_blocks_reverse ON monitor_log_blocks
              (device_id,local_id,business_date,max_sort_at DESC,max_file_id DESC,max_byte_offset DESC);
            CREATE TABLE monitor_log_receipts (
              id uuid PRIMARY KEY, file_key bigint NOT NULL REFERENCES monitor_log_files(id) ON DELETE CASCADE,
              byte_offset bigint NOT NULL, payload_hash bytea NOT NULL,
              business_date date NOT NULL, block_id bigint NOT NULL, ordinal integer NOT NULL,
              UNIQUE(file_key,byte_offset),
              FOREIGN KEY(business_date,block_id) REFERENCES monitor_log_blocks(business_date,id) ON DELETE CASCADE);
            CREATE INDEX monitor_log_receipts_block ON monitor_log_receipts(business_date,block_id);
            CREATE TABLE monitor_log_block_accounts (
              business_date date NOT NULL, block_id bigint NOT NULL,
              device_id uuid NOT NULL, local_id uuid NOT NULL, account_number varchar(64) NOT NULL,
              min_sort_at timestamptz NOT NULL, min_file_id uuid NOT NULL,
              min_byte_offset bigint NOT NULL, max_sort_at timestamptz NOT NULL,
              max_file_id uuid NOT NULL, max_byte_offset bigint NOT NULL,
              PRIMARY KEY(business_date,block_id,account_number),
              FOREIGN KEY(business_date,block_id) REFERENCES monitor_log_blocks(business_date,id)
                ON DELETE CASCADE) PARTITION BY RANGE(business_date);
            CREATE INDEX monitor_log_block_accounts_page ON monitor_log_block_accounts
              (device_id,local_id,business_date,account_number,min_sort_at,min_file_id,min_byte_offset);
            CREATE INDEX monitor_log_block_accounts_reverse ON monitor_log_block_accounts
              (device_id,local_id,business_date,account_number,max_sort_at DESC,max_file_id DESC,max_byte_offset DESC);
            CREATE TABLE monitor_log_storage_metrics (
              name text PRIMARY KEY, value jsonb NOT NULL,
              updated_at timestamptz NOT NULL DEFAULT now());
            CREATE FUNCTION monitor_log_guard_legacy_write() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF COALESCE(current_setting('apple.monitor_log_restore',true),'')<>'verified'
                AND EXISTS(SELECT 1 FROM monitor_log_storage_metrics
                WHERE name='storage-default' AND value->>'mode'='blocks')
                AND EXISTS(SELECT 1 FROM new_rows n LEFT JOIN monitor_log_storage_scopes s
                  ON s.device_id=n.device_id AND s.local_id=n.local_id
                  WHERE s.mode IS NULL OR s.mode='blocks') THEN
                RAISE EXCEPTION 'legacy log write disabled for compressed scope' USING ERRCODE='55000';
              END IF;
              RETURN NULL;
            END $$;
            CREATE TRIGGER monitor_log_guard_legacy_write AFTER INSERT ON monitor_log_entries
              REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
              EXECUTE FUNCTION monitor_log_guard_legacy_write();
          `,
            { transaction }
          );
        } catch (error) {
          logger.warn('压缩日志迁移失败', { errorCode: error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.warn('压缩日志迁移失败', { errorCode: error.name });
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          const [rows] = await queryInterface.sequelize.query(
            'SELECT 1 FROM monitor_log_receipts LIMIT 1',
            { transaction }
          );
          if (rows.length) throw new Error('日志新存储仍有数据，必须先完成revert和验证');
          await queryInterface.sequelize.query(
            `
            DROP TRIGGER IF EXISTS monitor_log_guard_legacy_write ON monitor_log_entries;
            DROP FUNCTION monitor_log_guard_legacy_write();
            DROP TABLE monitor_log_storage_metrics;
            DROP TABLE monitor_log_block_accounts;
            DROP TABLE monitor_log_receipts;
            DROP TABLE monitor_log_blocks;
            DROP SEQUENCE monitor_log_block_id_seq;
            DROP TABLE monitor_log_files;
            DROP TABLE monitor_log_storage_scopes;
          `,
            { transaction }
          );
        } catch (error) {
          logger.warn('压缩日志回退迁移失败', { errorCode: error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.warn('压缩日志回退迁移失败', { errorCode: error.name });
      throw error;
    }
  },
};
