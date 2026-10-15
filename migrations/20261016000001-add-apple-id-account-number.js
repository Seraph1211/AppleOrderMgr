'use strict';

const logger = require('../src/utils/logger');

module.exports = {
  /** 按内部 ID 回填独立账号编号，后续由数据库序列分配。 */
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `LOCK TABLE apple_ids IN ACCESS EXCLUSIVE MODE;
          CREATE SEQUENCE apple_ids_account_number_seq AS INTEGER START WITH 1 NO CYCLE;
          ALTER TABLE apple_ids ADD COLUMN account_number INTEGER;
          WITH numbered AS (
            SELECT id, row_number() OVER (ORDER BY id)::INTEGER AS number FROM apple_ids
          )
          UPDATE apple_ids SET account_number = numbered.number
            FROM numbered WHERE apple_ids.id = numbered.id;
          SELECT setval('apple_ids_account_number_seq',
            GREATEST((SELECT COUNT(*) FROM apple_ids), 1),
            EXISTS(SELECT 1 FROM apple_ids));
          ALTER SEQUENCE apple_ids_account_number_seq OWNED BY apple_ids.account_number;
          ALTER TABLE apple_ids
            ALTER COLUMN account_number SET DEFAULT nextval('apple_ids_account_number_seq'),
            ALTER COLUMN account_number SET NOT NULL,
            ADD CONSTRAINT uk_apple_ids_account_number UNIQUE (account_number),
            ADD CONSTRAINT chk_apple_ids_account_number_positive CHECK (account_number > 0);
          CREATE FUNCTION guard_apple_id_account_number() RETURNS TRIGGER LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.account_number IS DISTINCT FROM OLD.account_number THEN
              RAISE EXCEPTION 'Apple ID account number cannot be changed' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER guard_apple_id_account_number
            BEFORE UPDATE OF account_number ON apple_ids
            FOR EACH ROW EXECUTE FUNCTION guard_apple_id_account_number();`,
          { transaction }
        );
      });
    } catch (error) {
      logger.error('Apple ID 编号迁移失败', { errorType: error.name });
      throw error;
    }
  },

  /** 移除独立编号结构；保留内部 ID、账号和全部业务关联。 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `LOCK TABLE apple_ids IN ACCESS EXCLUSIVE MODE;
          DROP TRIGGER guard_apple_id_account_number ON apple_ids;
          DROP FUNCTION guard_apple_id_account_number();
          ALTER TABLE apple_ids DROP COLUMN account_number;`,
          { transaction }
        );
      });
    } catch (error) {
      logger.error('Apple ID 编号迁移回退失败', { errorType: error.name });
      throw error;
    }
  },
};
