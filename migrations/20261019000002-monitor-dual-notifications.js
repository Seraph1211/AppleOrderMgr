const logger = require('../src/utils/logger');

module.exports = {
  /** 事务演进双通道；保守保留旧 sending 事实。 */
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          CREATE TABLE monitor_notification_channels (
            channel varchar(10) PRIMARY KEY CHECK(channel IN ('email','wecom')),
            enabled boolean NOT NULL DEFAULT false, recipients jsonb NOT NULL DEFAULT '[]',
            send_recovery boolean NOT NULL DEFAULT true, webhook_cipher text,
            target_name varchar(100) NOT NULL DEFAULT '', target_version integer NOT NULL DEFAULT 1,
            policy_version integer NOT NULL DEFAULT 1, policy jsonb NOT NULL DEFAULT '{}',
            version integer NOT NULL DEFAULT 1, enabled_at timestamptz, paused_reason varchar(100),
            last_test jsonb, last_accepted_at timestamptz, updated_by integer,
            sender_generation integer NOT NULL DEFAULT 2 CHECK(sender_generation=2),
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
          );
          INSERT INTO monitor_notification_channels
            (channel,enabled,recipients,send_recovery,target_name,version,enabled_at)
            SELECT 'email',enabled,recipients,send_recovery,'监控邮件',version,
              CASE WHEN enabled THEN now() ELSE NULL END FROM monitor_notification_settings WHERE id=1;
          INSERT INTO monitor_notification_channels(channel,target_name) VALUES('wecom','监控异常群');
          INSERT INTO monitor_notification_channels(channel,target_name) VALUES('email','监控邮件') ON CONFLICT(channel) DO NOTHING;
          ALTER TABLE monitor_notification_deliveries
            ADD COLUMN channel varchar(10) NOT NULL DEFAULT 'email',
            ADD COLUMN target_version integer NOT NULL DEFAULT 1,
            ADD COLUMN policy_version integer NOT NULL DEFAULT 1,
            ADD COLUMN target_name varchar(100) NOT NULL DEFAULT '监控邮件',
            ADD COLUMN priority integer NOT NULL DEFAULT 0,
            ADD COLUMN expires_at timestamptz,
            ADD COLUMN lease_token uuid, ADD COLUMN lease_until timestamptz,
            ADD COLUMN dispatch_started_at timestamptz,
            ADD COLUMN error_code varchar(100), ADD COLUMN wait_reason varchar(100),
            ADD COLUMN version integer NOT NULL DEFAULT 1,
            ADD COLUMN recipient_results jsonb NOT NULL DEFAULT '{}',
            ADD COLUMN completed_at timestamptz,
            ADD COLUMN cancelled_by integer, ADD COLUMN cancel_reason varchar(200);
          ALTER TABLE monitor_notification_deliveries DROP CONSTRAINT monitor_notification_delivery_status;
          ALTER TABLE monitor_notification_deliveries DROP CONSTRAINT monitor_notification_delivery_category;
          UPDATE monitor_notification_deliveries SET status='accepted',completed_at=coalesce(sent_at,updated_at) WHERE status='sent';
          UPDATE monitor_notification_deliveries SET status='unknown',error_code='LEGACY_INFLIGHT_UNKNOWN',dispatch_started_at=updated_at WHERE status='sending';
          UPDATE monitor_notification_deliveries d SET status='skipped',error_code='LEGACY_TARGET_UNVERIFIED',completed_at=now()
            WHERE status='pending' AND NOT EXISTS(SELECT 1 FROM monitor_notification_settings s WHERE s.id=1 AND s.enabled AND s.recipients=d.recipient_snapshot);
          UPDATE monitor_notification_deliveries SET expires_at=created_at+interval '24 hours';
          UPDATE monitor_notification_deliveries SET completed_at=coalesce(sent_at,updated_at) WHERE status IN ('accepted','failed','skipped');
          ALTER TABLE monitor_notification_deliveries
            ADD CONSTRAINT monitor_notification_delivery_status CHECK(status IN ('pending','sending','accepted','unknown','failed','skipped')),
            ADD CONSTRAINT monitor_notification_delivery_category CHECK(category IN ('alert','recovery','reminder','test','summary','daily','storm')),
            ADD CONSTRAINT monitor_notification_delivery_channel CHECK(channel IN ('email','wecom'));
          ALTER TABLE monitor_notification_events
            ADD COLUMN event_key varchar(255), ADD COLUMN channel varchar(10) NOT NULL DEFAULT 'email',
            ADD COLUMN target_version integer NOT NULL DEFAULT 1,
            ADD COLUMN outcome varchar(20) NOT NULL DEFAULT 'pending',
            ADD COLUMN reminder_sequence integer NOT NULL DEFAULT 0;
          UPDATE monitor_notification_events SET event_key=source_key;
          ALTER TABLE monitor_notification_events ALTER COLUMN event_key SET NOT NULL;
          CREATE UNIQUE INDEX monitor_notification_event_scope ON monitor_notification_events(event_key,channel,target_version);
          CREATE INDEX monitor_notification_event_alert ON monitor_notification_events((payload->>'alertId'));
          CREATE INDEX monitor_notification_delivery_channel_due ON monitor_notification_deliveries(channel,status,not_before,priority DESC);
          CREATE INDEX monitor_notification_delivery_cursor ON monitor_notification_deliveries(created_at DESC,id DESC);
          CREATE INDEX monitor_notification_delivery_cleanup ON monitor_notification_deliveries(completed_at);
          CREATE TABLE monitor_notification_links (
            id uuid PRIMARY KEY, alert_id uuid NOT NULL REFERENCES monitor_alerts(id) ON DELETE RESTRICT,
            channel varchar(10) NOT NULL, target_version integer NOT NULL,
            initial_status varchar(20) NOT NULL, last_notified_at timestamptz,
            reminder_sequence integer NOT NULL DEFAULT 0, next_reminder_at timestamptz, recovery_queued_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(alert_id,channel,target_version)
          );
          CREATE INDEX monitor_notification_link_due ON monitor_notification_links(next_reminder_at);
          INSERT INTO monitor_notification_links(id,alert_id,channel,target_version,initial_status,last_notified_at)
            SELECT md5('legacy-email:'||a.id::text)::uuid,a.id,'email',1,
              CASE WHEN bool_or(d.status='accepted') THEN 'accepted' ELSE 'unknown' END,
              max(coalesce(d.sent_at,d.updated_at))
            FROM monitor_notification_events e JOIN monitor_notification_deliveries d ON d.id=e.delivery_id
            JOIN monitor_alerts a ON a.id::text=e.payload->>'alertId'
            WHERE d.status IN ('accepted','unknown') AND e.payload->>'category'='alert'
            GROUP BY a.id;
          CREATE TABLE notification_worker_states (
            lane varchar(20) PRIMARY KEY, heartbeat_at timestamptz, last_success_at timestamptz,
            error_code varchar(100),details jsonb NOT NULL DEFAULT '{}',
            created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
          );
          CREATE TABLE wecom_robot_budgets (
            fingerprint char(64) PRIMARY KEY, reservations jsonb NOT NULL DEFAULT '[]',
            waiters jsonb NOT NULL DEFAULT '{}', next_send_at timestamptz,
            storm jsonb NOT NULL DEFAULT '{}',
            created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
          );
          CREATE FUNCTION monitor_notification_sender_guard() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF (NEW.status='sending' OR (OLD.status='sending' AND NEW.status='pending') OR (OLD.status='sending' AND OLD.dispatch_started_at IS NOT NULL AND NEW.status<>OLD.status) OR NEW.attempts<>OLD.attempts)
              AND current_setting('app.monitor_sender_generation',true) IS DISTINCT FROM '2' THEN
              RAISE EXCEPTION 'MONITOR_SENDER_GENERATION_REQUIRED';
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER monitor_notification_sender_guard BEFORE UPDATE ON monitor_notification_deliveries
            FOR EACH ROW EXECUTE FUNCTION monitor_notification_sender_guard();
          CREATE FUNCTION monitor_notification_legacy_event_key() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            NEW.event_key := coalesce(NEW.event_key,NEW.source_key);
            RETURN NEW;
          END $$;
          CREATE TRIGGER monitor_notification_legacy_event_key BEFORE INSERT ON monitor_notification_events
            FOR EACH ROW EXECUTE FUNCTION monitor_notification_legacy_event_key();
        `,
          { transaction }
        );
      });
    } catch (error) {
      logger.error('双通道迁移失败', { errorCode: error.code || error.name });
      throw error;
    }
  },
  /** 仅无新增业务事实时允许回滚，拒绝删除真实投递证据。 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        const [rows] = await queryInterface.sequelize.query(
          `SELECT
          (SELECT count(*) FROM monitor_notification_deliveries WHERE channel<>'email' OR version>1 OR status='unknown') +
          (SELECT count(*) FROM monitor_notification_events WHERE source_key LIKE 'email:%' OR source_key LIKE 'wecom:%') +
          (SELECT count(*) FROM monitor_notification_links) +
          (SELECT count(*) FROM wecom_robot_budgets) +
          (SELECT count(*) FROM monitor_notification_channels c WHERE updated_at<>created_at OR webhook_cipher IS NOT NULL OR target_version>1 OR policy_version>1 OR (channel='wecom' AND (enabled OR version>1)) OR (channel='email' AND version<>(SELECT version FROM monitor_notification_settings WHERE id=1))) AS used`,
          { transaction }
        );
        if (Number(rows[0].used))
          throw new Error('NOTIFICATION_DATA_PRESERVATION: 新通知数据已使用，拒绝破坏性回滚');
        await queryInterface.sequelize.query(
          `
          DROP TRIGGER monitor_notification_sender_guard ON monitor_notification_deliveries;
          DROP FUNCTION monitor_notification_sender_guard();
          DROP TRIGGER monitor_notification_legacy_event_key ON monitor_notification_events;
          DROP FUNCTION monitor_notification_legacy_event_key();
          DROP TABLE wecom_robot_budgets,notification_worker_states,monitor_notification_links,monitor_notification_channels;
          ALTER TABLE monitor_notification_deliveries DROP CONSTRAINT monitor_notification_delivery_status;
          UPDATE monitor_notification_deliveries SET status='sent' WHERE status='accepted';
          UPDATE monitor_notification_deliveries SET status='failed' WHERE status='unknown';
          ALTER TABLE monitor_notification_deliveries DROP CONSTRAINT monitor_notification_delivery_category;
          ALTER TABLE monitor_notification_deliveries DROP CONSTRAINT monitor_notification_delivery_channel;
          ALTER TABLE monitor_notification_deliveries ADD CONSTRAINT monitor_notification_delivery_status CHECK(status IN ('pending','sending','sent','skipped','failed')),
            ADD CONSTRAINT monitor_notification_delivery_category CHECK(category IN ('alert','recovery','reminder','test'));
          DROP INDEX monitor_notification_event_scope,monitor_notification_event_alert,monitor_notification_delivery_channel_due,monitor_notification_delivery_cursor,monitor_notification_delivery_cleanup;
          ALTER TABLE monitor_notification_events DROP COLUMN event_key,DROP COLUMN channel,DROP COLUMN target_version,DROP COLUMN outcome,DROP COLUMN reminder_sequence;
          ALTER TABLE monitor_notification_deliveries DROP COLUMN channel,DROP COLUMN target_version,DROP COLUMN policy_version,DROP COLUMN target_name,DROP COLUMN priority,DROP COLUMN expires_at,DROP COLUMN lease_token,DROP COLUMN lease_until,DROP COLUMN dispatch_started_at,DROP COLUMN error_code,DROP COLUMN wait_reason,DROP COLUMN version,DROP COLUMN recipient_results,DROP COLUMN completed_at,DROP COLUMN cancelled_by,DROP COLUMN cancel_reason;
        `,
          { transaction }
        );
      });
    } catch (error) {
      logger.error('双通道回滚拒绝或失败', { errorCode: error.code || error.name });
      throw error;
    }
  },
};
