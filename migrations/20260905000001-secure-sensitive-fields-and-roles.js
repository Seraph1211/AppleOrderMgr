'use strict';

/**
 * 为敏感字段加密、统一账号状态与三角色权限模型准备数据库结构。
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(
        'DROP TRIGGER IF EXISTS trigger_recipients_id_card_last4 ON recipients',
        { transaction }
      );
      await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS auto_extract_id_card_last4()', {
        transaction,
      });

      await queryInterface.changeColumn(
        'apple_ids',
        'password',
        { type: Sequelize.TEXT, allowNull: false },
        { transaction }
      );
      await queryInterface.changeColumn(
        'recipients',
        'id_card_number',
        { type: Sequelize.TEXT, allowNull: false },
        { transaction }
      );

      await queryInterface.changeColumn(
        'recipients',
        'password',
        { type: Sequelize.TEXT, allowNull: true },
        { transaction }
      );
      await queryInterface.changeColumn(
        'orders',
        'apple_password',
        { type: Sequelize.TEXT, allowNull: true },
        { transaction }
      );
      await queryInterface.changeColumn(
        'orders',
        'recipient_id_card',
        { type: Sequelize.TEXT, allowNull: true },
        { transaction }
      );

      await queryInterface.addColumn(
        'recipients',
        'id_card_hash',
        {
          type: Sequelize.STRING(64),
          allowNull: true,
          comment: '身份证标准化值的 HMAC-SHA256 盲索引',
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        'ALTER TABLE recipients DROP CONSTRAINT IF EXISTS recipients_id_card_number_key',
        { transaction }
      );
      await queryInterface.sequelize.query('DROP INDEX IF EXISTS idx_recipients_id_card_number', {
        transaction,
      });
      await queryInterface.addIndex('recipients', ['id_card_hash'], {
        unique: true,
        name: 'uk_recipients_id_card_hash',
        transaction,
      });

      await queryInterface.sequelize.query(
        `ALTER TABLE apple_ids ALTER COLUMN status SET DEFAULT '未使用';
         ALTER TABLE recipients ALTER COLUMN status SET DEFAULT '未使用';
         ALTER TABLE apple_ids DROP CONSTRAINT IF EXISTS chk_apple_ids_status;
         ALTER TABLE recipients DROP CONSTRAINT IF EXISTS chk_recipients_status;
         ALTER TABLE apple_ids
           ADD CONSTRAINT chk_apple_ids_status
           CHECK (status IN ('未使用', '使用中', '已下架', '异常'));
         ALTER TABLE recipients
           ADD CONSTRAINT chk_recipients_status
           CHECK (status IN ('未使用', '使用中', '已下架', '异常'));`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        "UPDATE users SET role = 'operator' WHERE role = 'user'",
        {
          transaction,
        }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_role;
         ALTER TABLE users
           ADD CONSTRAINT chk_users_role CHECK (role IN ('admin', 'operator', 'readOnly'));`,
        { transaction }
      );
      await queryInterface.changeColumn(
        'users',
        'role',
        { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'operator' },
        { transaction }
      );
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(
        `ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_role;
         UPDATE users SET role = 'user' WHERE role IN ('operator', 'readOnly');
         ALTER TABLE users
           ADD CONSTRAINT chk_users_role CHECK (role IN ('admin', 'user'));`,
        { transaction }
      );
      await queryInterface.changeColumn(
        'users',
        'role',
        { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'user' },
        { transaction }
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE apple_ids DROP CONSTRAINT IF EXISTS chk_apple_ids_status;
         ALTER TABLE recipients DROP CONSTRAINT IF EXISTS chk_recipients_status;
         ALTER TABLE apple_ids ALTER COLUMN status SET DEFAULT 'active';
         ALTER TABLE recipients ALTER COLUMN status SET DEFAULT 'active';`,
        { transaction }
      );
      await queryInterface.removeIndex('recipients', 'uk_recipients_id_card_hash', { transaction });
      await queryInterface.removeColumn('recipients', 'id_card_hash', { transaction });
      await queryInterface.changeColumn(
        'apple_ids',
        'password',
        { type: Sequelize.STRING(255), allowNull: false },
        { transaction }
      );
      await queryInterface.changeColumn(
        'recipients',
        'id_card_number',
        { type: Sequelize.STRING(18), allowNull: false, unique: true },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE OR REPLACE FUNCTION auto_extract_id_card_last4()
         RETURNS TRIGGER AS $$
         BEGIN
           IF NEW.id_card_number IS NOT NULL THEN
             NEW.id_card_last4 = RIGHT(NEW.id_card_number, 4);
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE TRIGGER trigger_recipients_id_card_last4
         BEFORE INSERT OR UPDATE ON recipients
         FOR EACH ROW
         EXECUTE FUNCTION auto_extract_id_card_last4()`,
        { transaction }
      );
      await queryInterface.changeColumn(
        'recipients',
        'password',
        { type: Sequelize.STRING(100), allowNull: true },
        { transaction }
      );
      await queryInterface.changeColumn(
        'orders',
        'apple_password',
        { type: Sequelize.STRING(255), allowNull: true },
        { transaction }
      );
      await queryInterface.changeColumn(
        'orders',
        'recipient_id_card',
        { type: Sequelize.STRING(18), allowNull: true },
        { transaction }
      );
    });
  },
};
