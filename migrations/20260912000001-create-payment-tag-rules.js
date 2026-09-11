const logger = require('../src/utils/logger');
'use strict';

module.exports = {
  /** 创建 TAG 规则及数组边界约束。 */
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.createTable(
            'payment_tag_rules',
            {
              id: {
                type: Sequelize.INTEGER,
                primaryKey: true,
                autoIncrement: true,
                allowNull: false,
              },
              name: { type: Sequelize.STRING(100), allowNull: false },
              enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
              recipient_tags: { type: Sequelize.JSONB, allowNull: false },
              assignee_user_ids: { type: Sequelize.JSONB, allowNull: false },
              version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
              updated_by: {
                type: Sequelize.INTEGER,
                allowNull: true,
                references: { model: 'users', key: 'id' },
                onDelete: 'SET NULL',
                onUpdate: 'CASCADE',
              },
              created_at: { type: Sequelize.DATE, allowNull: false },
              updated_at: { type: Sequelize.DATE, allowNull: false },
            },
            { transaction }
          );
          await queryInterface.sequelize.query(
            `ALTER TABLE payment_tag_rules
            ADD CONSTRAINT payment_tag_rules_tags_check CHECK (
              jsonb_typeof(recipient_tags) = 'array' AND jsonb_array_length(recipient_tags) BETWEEN 1 AND 100),
            ADD CONSTRAINT payment_tag_rules_users_check CHECK (
              jsonb_typeof(assignee_user_ids) = 'array' AND jsonb_array_length(assignee_user_ids) BETWEEN 1 AND 100),
            ADD CONSTRAINT payment_tag_rules_version_check CHECK (version >= 0)`,
            { transaction }
          );
        } catch (error) {
          logger.error('TAG 分配操作失败', { errorCode: error.code || 'TAG_RULE_FAILED' });
          throw error;
        }
      });
    } catch (error) {
      logger.error('TAG 分配操作失败', { errorCode: error.code || 'TAG_RULE_FAILED' });
      throw error;
    }
  },
  /** 回滚仅移除 TAG 规则表，保留审计记录。 */
  async down(queryInterface) {
    try {
      await queryInterface.dropTable('payment_tag_rules');
    } catch (error) {
      logger.error('TAG 分配操作失败', { errorCode: error.code || 'TAG_RULE_FAILED' });
      throw error;
    }
  },
};
