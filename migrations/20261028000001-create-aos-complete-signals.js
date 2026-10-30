module.exports = {
  /** 创建完整通知派生状态及来源变更历史。 @param {Object} queryInterface 数据库接口 @returns {Promise<void>} 完成 */
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.sequelize.query(
            `
            CREATE TABLE aos_signal_windows (
              id varchar(64) PRIMARY KEY, since timestamptz NOT NULL,
              window_from timestamptz NOT NULL, window_to timestamptz NOT NULL,
              status varchar(20) NOT NULL DEFAULT 'waiting'
                CHECK(status IN ('waiting','computing','ready','blocked','accepted','unknown','cancelled')),
              version integer NOT NULL DEFAULT 1 CHECK(version>0),
              lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz NOT NULL,
              body jsonb NOT NULL DEFAULT '{}',
              created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
              UNIQUE(since,window_from), CHECK(window_to>window_from));
            CREATE INDEX aos_signal_windows_due ON aos_signal_windows(status,next_attempt_at);
            CREATE INDEX aos_strict_delivery_window ON inventory_deliveries ((body->>'aosWindowId')) WHERE body->>'aosStrict'='true';
            CREATE INDEX aos_signal_windows_range ON aos_signal_windows(window_to);
            CREATE TABLE aos_signal_evidence (
              id varchar(200) PRIMARY KEY, device_id uuid NOT NULL, local_id uuid NOT NULL,
              file_id uuid NOT NULL, task_key varchar(64) NOT NULL, logged_at timestamptz NOT NULL,
              byte_offset bigint NOT NULL CHECK(byte_offset>=0), line_index integer NOT NULL DEFAULT 0 CHECK(line_index>=0),
              kind varchar(16) NOT NULL CHECK(kind IN ('anchor','stock','reset','booking','product')),
              body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
            CREATE INDEX aos_signal_evidence_time ON aos_signal_evidence(kind,logged_at,id);
            CREATE INDEX aos_signal_evidence_task ON aos_signal_evidence(task_key,byte_offset DESC,line_index DESC);
            CREATE INDEX aos_account_start_lookup ON aos_account_config_events
              (device_id,local_id,account_number,logged_at DESC,byte_offset DESC,line_index DESC) WHERE kind='start';
            CREATE TABLE aos_coverage_files (
              id varchar(64) PRIMARY KEY, device_id uuid NOT NULL, local_id uuid NOT NULL, file_id uuid NOT NULL,
              body jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
              UNIQUE(device_id,local_id,file_id));
            CREATE TABLE aos_signal_rosters (
              id bigserial PRIMARY KEY, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), body jsonb NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
            CREATE INDEX aos_signal_rosters_time ON aos_signal_rosters(recorded_at DESC,id DESC);
            CREATE FUNCTION aos_record_signal_roster() RETURNS trigger LANGUAGE plpgsql AS $fn$
            DECLARE snapshot jsonb; previous jsonb;
            BEGIN
              PERFORM pg_advisory_xact_lock(20261028,1);
              SELECT jsonb_build_object('sources',coalesce(jsonb_agg(jsonb_build_object(
                'deviceId',d.id,'localId',i.local_id,'server',d.name,'instance',i.label,
                'enabled',d.enabled AND i.active) ORDER BY d.id,i.local_id),'[]'::jsonb)) INTO snapshot
              FROM aos_devices d JOIN monitor_instances i ON i.device_id=d.id;
              SELECT body->'sources' INTO previous FROM aos_signal_rosters ORDER BY id DESC LIMIT 1;
              IF previous IS DISTINCT FROM snapshot->'sources' THEN
                INSERT INTO aos_signal_rosters(body) VALUES(snapshot);
                UPDATE aos_signal_windows SET version=version+1,
                  status=CASE WHEN status='computing' THEN status ELSE 'waiting' END,
                  next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
                  WHERE status<>'cancelled' AND window_to>clock_timestamp();
              END IF;
              RETURN NULL;
            END $fn$;
            CREATE TRIGGER aos_device_roster_insert AFTER INSERT OR DELETE ON aos_devices
              FOR EACH STATEMENT EXECUTE FUNCTION aos_record_signal_roster();
            CREATE TRIGGER aos_device_roster_update AFTER UPDATE OF enabled,name ON aos_devices
              FOR EACH STATEMENT EXECUTE FUNCTION aos_record_signal_roster();
            CREATE TRIGGER aos_instance_roster_insert AFTER INSERT OR DELETE ON monitor_instances
              FOR EACH STATEMENT EXECUTE FUNCTION aos_record_signal_roster();
            CREATE TRIGGER aos_instance_roster_update AFTER UPDATE OF active,local_id,device_id,label ON monitor_instances
              FOR EACH STATEMENT EXECUTE FUNCTION aos_record_signal_roster();
            INSERT INTO aos_signal_rosters(body)
              SELECT jsonb_build_object('baseline',true,'sources',coalesce(jsonb_agg(jsonb_build_object(
                'deviceId',d.id,'localId',i.local_id,'server',d.name,'instance',i.label,
                'enabled',d.enabled AND i.active) ORDER BY d.id,i.local_id),'[]'::jsonb))
              FROM aos_devices d JOIN monitor_instances i ON i.device_id=d.id;
          `,
            { transaction }
          );
        } catch (error) {
          throw new Error('AOS_COMPLETE_MIGRATION_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('AOS_COMPLETE_MIGRATION_FAILED', { cause: error });
    }
  },
  /** 隔离恢复演练回退；生产回退保留未完成任务。 @param {Object} queryInterface 数据库接口 @returns {Promise<void>} 完成 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.sequelize.query(
            `
            DROP TRIGGER aos_device_roster_insert ON aos_devices;
            DROP TRIGGER aos_device_roster_update ON aos_devices;
            DROP TRIGGER aos_instance_roster_insert ON monitor_instances;
            DROP TRIGGER aos_instance_roster_update ON monitor_instances;
            DROP FUNCTION aos_record_signal_roster();
            DROP INDEX aos_strict_delivery_window;
            DROP TABLE aos_signal_rosters;
            DROP TABLE aos_coverage_files;
            DROP INDEX aos_account_start_lookup;
            DROP TABLE aos_signal_evidence;
            DROP TABLE aos_signal_windows;
          `,
            { transaction }
          );
        } catch (error) {
          throw new Error('AOS_COMPLETE_DOWN_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('AOS_COMPLETE_DOWN_FAILED', { cause: error });
    }
  },
};
