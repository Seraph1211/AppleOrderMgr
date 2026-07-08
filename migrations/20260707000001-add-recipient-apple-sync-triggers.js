'use strict';

/**
 * 补齐收件人与 Apple ID 的冗余字段同步触发器
 * @description recipients.apple_id_ref 变更时同步 apple_id/password；apple_ids 密码或账号变更时反向同步
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION sync_bound_apple_id_info()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.apple_id_ref IS NULL THEN
          NEW.apple_id = NULL;
          NEW.password = NULL;
        ELSE
          SELECT apple_id, password
          INTO NEW.apple_id, NEW.password
          FROM apple_ids
          WHERE id = NEW.apple_id_ref;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS trigger_sync_bound_apple_id ON recipients;

      CREATE TRIGGER trigger_sync_bound_apple_id
      BEFORE INSERT OR UPDATE OF apple_id_ref ON recipients
      FOR EACH ROW
      EXECUTE FUNCTION sync_bound_apple_id_info();
    `);

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION sync_apple_password_to_recipients()
      RETURNS TRIGGER AS $$
      BEGIN
        UPDATE recipients
        SET
          apple_id = NEW.apple_id,
          password = NEW.password,
          updated_at = CURRENT_TIMESTAMP
        WHERE apple_id_ref = NEW.id
          AND (
            apple_id IS DISTINCT FROM NEW.apple_id
            OR password IS DISTINCT FROM NEW.password
          );

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS trigger_sync_password_to_recipients ON apple_ids;

      CREATE TRIGGER trigger_sync_password_to_recipients
      AFTER UPDATE OF apple_id, password ON apple_ids
      FOR EACH ROW
      EXECUTE FUNCTION sync_apple_password_to_recipients();
    `);

    await queryInterface.sequelize.query(`
      UPDATE recipients AS r
      SET
        apple_id = a.apple_id,
        password = a.password,
        updated_at = CURRENT_TIMESTAMP
      FROM apple_ids AS a
      WHERE r.apple_id_ref = a.id
        AND (
          r.apple_id IS DISTINCT FROM a.apple_id
          OR r.password IS DISTINCT FROM a.password
        );
    `);

    await queryInterface.sequelize.query(`
      UPDATE recipients
      SET
        apple_id = NULL,
        password = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE apple_id_ref IS NULL
        AND (
          apple_id IS NOT NULL
          OR password IS NOT NULL
        );
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS trigger_sync_password_to_recipients ON apple_ids;');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS sync_apple_password_to_recipients();');
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS trigger_sync_bound_apple_id ON recipients;');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS sync_bound_apple_id_info();');
  }
};
