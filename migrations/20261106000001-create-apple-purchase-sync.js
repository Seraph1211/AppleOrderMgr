/* eslint-disable camelcase -- Migration 使用数据库列名 */

const SCHEMA = 'apple_purchase_sync';

module.exports = {
  /** 建立 ApplePurchase 同步独立结构、固定通知函数与最小权限角色。 @returns {Promise<void>} 完成 */
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          DO $$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apple_purchase_sync_ingest') THEN
              CREATE ROLE apple_purchase_sync_ingest NOLOGIN;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apple_purchase_sync_read') THEN
              CREATE ROLE apple_purchase_sync_read NOLOGIN;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apple_purchase_sync_admin') THEN
              CREATE ROLE apple_purchase_sync_admin NOLOGIN;
            END IF;
          END $$;

          CREATE SCHEMA ${SCHEMA};
          REVOKE ALL ON SCHEMA ${SCHEMA} FROM PUBLIC;

          CREATE TABLE ${SCHEMA}.terminals (
            id UUID PRIMARY KEY,
            name VARCHAR(128) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 128),
            token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
            token_prefix VARCHAR(24) NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            token_created_at TIMESTAMPTZ NOT NULL,
            token_rotated_at TIMESTAMPTZ,
            last_seen_at TIMESTAMPTZ,
            last_success_at TIMESTAMPTZ,
            observation_high_water BIGINT NOT NULL DEFAULT 0 CHECK (observation_high_water >= 0),
            monitor_change_high_water BIGINT NOT NULL DEFAULT 0 CHECK (monitor_change_high_water >= 0),
            source_history JSONB NOT NULL DEFAULT '{"observations":{"availableFrom":null,"completeness":"unknown_before_available_from"},"monitorChanges":{"availableFrom":null,"completeness":"unknown_before_available_from"}}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            revoked_at TIMESTAMPTZ,
            CHECK ((enabled AND revoked_at IS NULL) OR (NOT enabled)),
            CHECK (jsonb_typeof(source_history) = 'object')
          );

          CREATE TABLE ${SCHEMA}.ingest_batches (
            terminal_id UUID NOT NULL REFERENCES ${SCHEMA}.terminals(id) ON DELETE RESTRICT,
            batch_id UUID NOT NULL,
            request_id UUID NOT NULL,
            payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
            mode VARCHAR(16) NOT NULL CHECK (mode IN ('live', 'backfill')),
            sent_at TIMESTAMPTZ NOT NULL,
            source_history JSONB NOT NULL CHECK (jsonb_typeof(source_history) = 'object'),
            event_count INTEGER NOT NULL CHECK (event_count BETWEEN 1 AND 500),
            accepted_observations INTEGER NOT NULL DEFAULT 0 CHECK (accepted_observations >= 0),
            accepted_monitor_changes INTEGER NOT NULL DEFAULT 0 CHECK (accepted_monitor_changes >= 0),
            duplicate_observations INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_observations >= 0),
            duplicate_monitor_changes INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_monitor_changes >= 0),
            observation_high_water BIGINT NOT NULL DEFAULT 0 CHECK (observation_high_water >= 0),
            monitor_change_high_water BIGINT NOT NULL DEFAULT 0 CHECK (monitor_change_high_water >= 0),
            result_status VARCHAR(16) NOT NULL DEFAULT 'processing' CHECK (result_status IN ('processing', 'committed')),
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            committed_at TIMESTAMPTZ,
            PRIMARY KEY (terminal_id, batch_id),
            CHECK ((result_status = 'processing' AND committed_at IS NULL) OR (result_status = 'committed' AND committed_at IS NOT NULL))
          );

          CREATE TABLE ${SCHEMA}.observations (
            sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            terminal_id UUID NOT NULL REFERENCES ${SCHEMA}.terminals(id) ON DELETE RESTRICT,
            observation_id VARCHAR(128) NOT NULL,
            source_sequence BIGINT NOT NULL CHECK (source_sequence >= 0),
            response_received_at TIMESTAMPTZ NOT NULL,
            response_received_at_ms BIGINT NOT NULL CHECK (response_received_at_ms >= 0),
            city VARCHAR(128),
            store_id VARCHAR(128) NOT NULL,
            official_store_id VARCHAR(64),
            store_name VARCHAR(256) NOT NULL,
            part_number VARCHAR(128) NOT NULL,
            product_id VARCHAR(128),
            product_name VARCHAR(256) NOT NULL,
            specification VARCHAR(512) NOT NULL,
            official_title VARCHAR(512),
            color VARCHAR(128),
            storage VARCHAR(64),
            family VARCHAR(64) NOT NULL,
            availability VARCHAR(16) NOT NULL CHECK (availability = 'available'),
            batch_id UUID NOT NULL,
            ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            content_digest CHAR(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
            UNIQUE (terminal_id, observation_id),
            FOREIGN KEY (terminal_id, batch_id) REFERENCES ${SCHEMA}.ingest_batches(terminal_id, batch_id) ON DELETE RESTRICT
          );

          CREATE TABLE ${SCHEMA}.monitor_changes (
            sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            terminal_id UUID NOT NULL REFERENCES ${SCHEMA}.terminals(id) ON DELETE RESTRICT,
            event_id VARCHAR(128) NOT NULL,
            source_sequence BIGINT NOT NULL CHECK (source_sequence >= 0),
            monitor_id VARCHAR(128) NOT NULL,
            monitor_name VARCHAR(256) NOT NULL,
            change_type VARCHAR(40) NOT NULL CHECK (change_type IN ('baseline_created', 'configuration_updated', 'monitor_started', 'monitor_stopped', 'task_demand_updated')),
            changed_at TIMESTAMPTZ NOT NULL,
            changed_at_ms BIGINT NOT NULL CHECK (changed_at_ms >= 0),
            previous_revision INTEGER CHECK (previous_revision >= 0),
            revision INTEGER CHECK (revision >= 0),
            before_json JSONB CHECK (before_json IS NULL OR jsonb_typeof(before_json) = 'object'),
            after_json JSONB CHECK (after_json IS NULL OR jsonb_typeof(after_json) = 'object'),
            changes_json JSONB NOT NULL CHECK (jsonb_typeof(changes_json) = 'array' AND jsonb_array_length(changes_json) <= 200),
            source VARCHAR(16) NOT NULL CHECK (source IN ('user', 'system', 'task', 'migration')),
            task_id VARCHAR(128),
            batch_id UUID NOT NULL,
            ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            content_digest CHAR(64) NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
            UNIQUE (terminal_id, event_id),
            FOREIGN KEY (terminal_id, batch_id) REFERENCES ${SCHEMA}.ingest_batches(terminal_id, batch_id) ON DELETE RESTRICT
          );

          CREATE TABLE ${SCHEMA}.terminal_audit_events (
            sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            terminal_id UUID NOT NULL REFERENCES ${SCHEMA}.terminals(id) ON DELETE RESTRICT,
            actor_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
            action VARCHAR(32) NOT NULL CHECK (action IN ('created', 'updated', 'token_rotated')),
            changes JSONB NOT NULL CHECK (jsonb_typeof(changes) = 'object'),
            request_id UUID NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          CREATE INDEX ingest_batches_received_at_idx ON ${SCHEMA}.ingest_batches(received_at DESC);
          CREATE INDEX observations_received_sequence_idx ON ${SCHEMA}.observations(response_received_at DESC, sequence DESC);
          CREATE INDEX observations_store_part_received_idx ON ${SCHEMA}.observations(store_id, part_number, response_received_at DESC, sequence DESC);
          CREATE INDEX observations_terminal_sequence_idx ON ${SCHEMA}.observations(terminal_id, sequence DESC);
          CREATE INDEX monitor_changes_changed_sequence_idx ON ${SCHEMA}.monitor_changes(changed_at DESC, sequence DESC);
          CREATE INDEX monitor_changes_monitor_changed_idx ON ${SCHEMA}.monitor_changes(monitor_id, changed_at DESC, sequence DESC);
          CREATE INDEX monitor_changes_terminal_sequence_idx ON ${SCHEMA}.monitor_changes(terminal_id, sequence DESC);
          CREATE INDEX terminal_audit_terminal_created_idx ON ${SCHEMA}.terminal_audit_events(terminal_id, created_at DESC);

          CREATE FUNCTION ${SCHEMA}.publish_inventory_version(observation_sequence BIGINT, monitor_change_sequence BIGINT)
          RETURNS VOID
          LANGUAGE plpgsql
          SECURITY DEFINER
          SET search_path = pg_catalog
          AS $$
          BEGIN
            PERFORM pg_notify(
              'apple_purchase_inventory_version',
              json_build_object(
                'observations', observation_sequence::text,
                'monitorChanges', monitor_change_sequence::text
              )::text
            );
          END;
          $$;

          REVOKE ALL ON ALL TABLES IN SCHEMA ${SCHEMA} FROM PUBLIC;
          REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} FROM PUBLIC;
          REVOKE ALL ON FUNCTION ${SCHEMA}.publish_inventory_version(BIGINT, BIGINT) FROM PUBLIC;

          GRANT USAGE ON SCHEMA ${SCHEMA} TO apple_purchase_sync_ingest, apple_purchase_sync_read, apple_purchase_sync_admin;
          GRANT SELECT (id, token_hash, enabled, observation_high_water, monitor_change_high_water)
            ON ${SCHEMA}.terminals TO apple_purchase_sync_ingest;
          GRANT UPDATE (
            last_seen_at, last_success_at, observation_high_water,
            monitor_change_high_water, source_history, updated_at
          ) ON ${SCHEMA}.terminals TO apple_purchase_sync_ingest;
          GRANT SELECT, INSERT, UPDATE ON ${SCHEMA}.ingest_batches TO apple_purchase_sync_ingest;
          GRANT SELECT, INSERT ON ${SCHEMA}.observations, ${SCHEMA}.monitor_changes TO apple_purchase_sync_ingest;
          GRANT USAGE, SELECT ON SEQUENCE ${SCHEMA}.observations_sequence_seq, ${SCHEMA}.monitor_changes_sequence_seq TO apple_purchase_sync_ingest;
          GRANT EXECUTE ON FUNCTION ${SCHEMA}.publish_inventory_version(BIGINT, BIGINT) TO apple_purchase_sync_ingest;

          GRANT SELECT (
            id, name, enabled, last_seen_at, last_success_at,
            observation_high_water, monitor_change_high_water, source_history, created_at
          ) ON ${SCHEMA}.terminals TO apple_purchase_sync_read;
          GRANT SELECT ON ${SCHEMA}.observations, ${SCHEMA}.monitor_changes TO apple_purchase_sync_read;
          GRANT SELECT (
            id, name, enabled, token_prefix, token_created_at, token_rotated_at,
            last_seen_at, last_success_at, observation_high_water, monitor_change_high_water,
            created_at, updated_at, revoked_at
          ) ON ${SCHEMA}.terminals TO apple_purchase_sync_admin;
          GRANT INSERT (
            id, name, token_hash, token_prefix, enabled, token_created_at,
            created_at, updated_at, revoked_at
          ) ON ${SCHEMA}.terminals TO apple_purchase_sync_admin;
          GRANT UPDATE (
            name, enabled, token_hash, token_prefix, token_created_at,
            token_rotated_at, updated_at, revoked_at
          ) ON ${SCHEMA}.terminals TO apple_purchase_sync_admin;
          GRANT INSERT (terminal_id, actor_user_id, action, changes, request_id)
            ON ${SCHEMA}.terminal_audit_events TO apple_purchase_sync_admin;
          GRANT USAGE, SELECT ON SEQUENCE ${SCHEMA}.terminal_audit_events_sequence_seq TO apple_purchase_sync_admin;
          `,
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('ApplePurchase 同步结构迁移失败', { cause: error });
    }
  },

  /** 删除同步 schema；最小权限角色保留，避免破坏已有成员关系。 @returns {Promise<void>} 完成 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(`DROP SCHEMA ${SCHEMA} CASCADE`, { transaction });
      });
    } catch (error) {
      throw new Error('ApplePurchase 同步结构回滚失败', { cause: error });
    }
  },
};
