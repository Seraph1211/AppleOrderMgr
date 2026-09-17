'use strict';
const logger = require('../src/utils/logger');

/** 基础档案、双向唯一绑定和关系历史；遇到存量冲突阻断，不静默合并。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        const sql = statement => queryInterface.sequelize.query(statement, { transaction });
        await sql(`LOCK TABLE recipients, apple_ids IN SHARE ROW EXCLUSIVE MODE;
          DO $$ BEGIN
            IF EXISTS (SELECT apple_id_ref FROM recipients WHERE apple_id_ref IS NOT NULL
              GROUP BY apple_id_ref HAVING count(*) > 1) THEN
              RAISE EXCEPTION '存在重复当前绑定，请先核对并裁定';
            END IF;
            IF EXISTS (SELECT lower(trim(apple_id)) FROM apple_ids
              GROUP BY lower(trim(apple_id)) HAVING count(*) > 1) THEN
              RAISE EXCEPTION '存在标准化后重复账号，请先核对并裁定';
            END IF;
          END $$;`);
        await queryInterface.addColumn(
          'recipients',
          'real_phone',
          {
            type: Sequelize.STRING(20),
            allowNull: true,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'apple_ids',
          'notes',
          {
            type: Sequelize.TEXT,
            allowNull: true,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'recipient_id_last4',
          {
            type: Sequelize.STRING(4),
            allowNull: true,
          },
          { transaction }
        );
        await sql(`UPDATE apple_ids SET notes = nickname;
          ALTER TABLE apple_ids ALTER COLUMN country SET DEFAULT '中国';
          CREATE UNIQUE INDEX uk_recipients_current_apple ON recipients(apple_id_ref)
            WHERE apple_id_ref IS NOT NULL;
          CREATE UNIQUE INDEX uk_apple_ids_normalized ON apple_ids(lower(trim(apple_id)));
          CREATE TABLE profile_bindings (
            id BIGSERIAL PRIMARY KEY,
            recipient_id INTEGER REFERENCES recipients(id) ON DELETE SET NULL,
            apple_id_ref INTEGER REFERENCES apple_ids(id) ON DELETE SET NULL,
            recipient_name TEXT NOT NULL,
            apple_id TEXT NOT NULL,
            started_at TIMESTAMPTZ,
            ended_at TIMESTAMPTZ,
            observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL
          );
          CREATE INDEX idx_profile_bindings_recipient ON profile_bindings(recipient_id, id);
          CREATE INDEX idx_profile_bindings_apple ON profile_bindings(apple_id_ref, id);
          INSERT INTO profile_bindings(recipient_id, apple_id_ref, recipient_name, apple_id)
            SELECT r.id, a.id, r.last_name || r.first_name, a.apple_id
            FROM recipients r JOIN apple_ids a ON a.id=r.apple_id_ref;
          CREATE FUNCTION track_profile_binding() RETURNS TRIGGER AS $$
          BEGIN
            IF TG_OP = 'UPDATE' AND NEW.apple_id_ref IS NOT DISTINCT FROM OLD.apple_id_ref THEN
              RETURN NEW;
            END IF;
            IF TG_OP <> 'INSERT' THEN
              UPDATE profile_bindings SET ended_at=CURRENT_TIMESTAMP
                WHERE recipient_id=OLD.id AND ended_at IS NULL;
            END IF;
            IF TG_OP <> 'DELETE' AND NEW.apple_id_ref IS NOT NULL THEN
              INSERT INTO profile_bindings(recipient_id, apple_id_ref, recipient_name,
                apple_id, started_at, actor_id)
              SELECT NEW.id, a.id, NEW.last_name || NEW.first_name, a.apple_id,
                CASE WHEN current_setting('app.binding_initial', true)='true'
                  THEN NULL ELSE CURRENT_TIMESTAMP END,
                NULLIF(current_setting('app.actor_id', true), '')::integer
              FROM apple_ids a WHERE a.id=NEW.apple_id_ref;
            END IF;
            IF TG_OP='DELETE' THEN RETURN OLD; END IF;
            RETURN NEW;
          END $$ LANGUAGE plpgsql;
          CREATE TRIGGER trigger_profile_binding AFTER INSERT OR UPDATE OF apple_id_ref
            ON recipients FOR EACH ROW EXECUTE FUNCTION track_profile_binding();
          CREATE TRIGGER trigger_profile_unbinding BEFORE DELETE
            ON recipients FOR EACH ROW EXECUTE FUNCTION track_profile_binding();`);
      });
    } catch (error) {
      logger.warn('基础档案操作未完成', { errorType: error.name });
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          DROP TRIGGER trigger_profile_unbinding ON recipients;
          DROP TRIGGER trigger_profile_binding ON recipients;
          DROP FUNCTION track_profile_binding();
          DROP TABLE profile_bindings;
          DROP INDEX uk_recipients_current_apple;
          DROP INDEX uk_apple_ids_normalized;
          ALTER TABLE apple_ids ALTER COLUMN country DROP DEFAULT;
          UPDATE apple_ids SET nickname=notes WHERE notes IS NULL OR length(notes)<=255;
          ALTER TABLE apple_ids DROP COLUMN notes;
          ALTER TABLE recipients DROP COLUMN real_phone;
          ALTER TABLE orders DROP COLUMN recipient_id_last4;
        `,
          { transaction }
        );
      });
    } catch (error) {
      logger.warn('基础档案操作未完成', { errorType: error.name });
      throw error;
    }
  },
};
