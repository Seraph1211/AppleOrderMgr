'use strict';
const logger = require('../src/utils/logger');

/** 结束当前绑定；保留空兼容列和历史证据，订单及账号主档不变。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          LOCK TABLE recipients, apple_ids, profile_bindings IN SHARE ROW EXCLUSIVE MODE;
          DROP TRIGGER IF EXISTS trigger_sync_bound_apple_id ON recipients;
          DROP TRIGGER IF EXISTS trigger_sync_password_to_recipients ON apple_ids;
          DROP TRIGGER IF EXISTS trigger_profile_binding ON recipients;
          DROP TRIGGER IF EXISTS trigger_profile_unbinding ON recipients;
          DROP TRIGGER IF EXISTS guard_proxy_recipient ON recipients;
          CREATE OR REPLACE FUNCTION guard_proxy_pool_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
          BEGIN
            PERFORM pg_advisory_xact_lock(17092026);
            IF NOT NEW.is_proxy_pool AND EXISTS(SELECT 1 FROM proxy_assignments WHERE apple_id_ref=NEW.id AND ended_at IS NULL) THEN
              RAISE EXCEPTION '占用账号不能移出代抢池' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
          END $$;

          UPDATE profile_bindings SET ended_at=GREATEST(CURRENT_TIMESTAMP, observed_at, started_at)
            WHERE ended_at IS NULL;
          UPDATE recipients SET apple_id_ref=NULL, apple_id=NULL, password=NULL
            WHERE apple_id_ref IS NOT NULL OR apple_id IS NOT NULL OR password IS NOT NULL;
          DROP INDEX IF EXISTS uk_recipients_current_apple;
          ALTER TABLE recipients ADD CONSTRAINT chk_recipients_profiles_independent
            CHECK (apple_id_ref IS NULL AND apple_id IS NULL AND password IS NULL);
        `,
          { transaction }
        );
      });
    } catch (error) {
      logger.error('解除档案绑定迁移失败', { errorType: error.name });
      throw error;
    }
  },
  /** 仅回退结构；不恢复关系、不重开历史，完整数据恢复必须使用备份。 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          LOCK TABLE recipients, apple_ids, profile_bindings IN SHARE ROW EXCLUSIVE MODE;
          ALTER TABLE recipients DROP CONSTRAINT chk_recipients_profiles_independent;
          CREATE UNIQUE INDEX uk_recipients_current_apple ON recipients(apple_id_ref)
            WHERE apple_id_ref IS NOT NULL;
          CREATE TRIGGER trigger_sync_bound_apple_id BEFORE INSERT OR UPDATE OF apple_id_ref
            ON recipients FOR EACH ROW EXECUTE FUNCTION sync_bound_apple_id_info();
          CREATE TRIGGER trigger_sync_password_to_recipients AFTER UPDATE OF apple_id, password
            ON apple_ids FOR EACH ROW EXECUTE FUNCTION sync_apple_password_to_recipients();
          CREATE TRIGGER trigger_profile_binding AFTER INSERT OR UPDATE OF apple_id_ref
            ON recipients FOR EACH ROW EXECUTE FUNCTION track_profile_binding();
          CREATE TRIGGER trigger_profile_unbinding BEFORE DELETE
            ON recipients FOR EACH ROW EXECUTE FUNCTION track_profile_binding();
          CREATE OR REPLACE FUNCTION guard_proxy_pool_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
          CREATE TRIGGER guard_proxy_recipient BEFORE INSERT OR UPDATE OF apple_id_ref
            ON recipients FOR EACH ROW EXECUTE FUNCTION guard_proxy_pool_binding();
        `,
          { transaction }
        );
      });
    } catch (error) {
      logger.error('解除档案绑定结构回退失败', { errorType: error.name });
      throw error;
    }
  },
};
