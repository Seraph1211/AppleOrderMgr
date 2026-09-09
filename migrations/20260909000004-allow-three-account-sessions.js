const logger = require('../src/utils/logger');

/** 为三台设备保存独立会话，并保留迁移前的有效登录。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.addColumn(
          'users',
          'active_sessions',
          {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: [],
          },
          { transaction }
        );
        await queryInterface.sequelize.query(
          `
          UPDATE users SET active_sessions = jsonb_build_array(jsonb_build_object(
            'id', active_session_id, 'expiresAt', active_session_expires_at,
            'createdAt', COALESCE(last_login_at, NOW())
          )) WHERE active_session_id IS NOT NULL AND active_session_expires_at > NOW();
          ALTER TABLE users ADD CONSTRAINT users_active_sessions_limit
            CHECK (jsonb_typeof(active_sessions) = 'array' AND jsonb_array_length(active_sessions) <= 3);
        `,
          { transaction }
        );
      });
    } catch (error) {
      logger.error('三设备会话迁移失败', { error: error.message });
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          UPDATE users u SET
            active_session_id = (SELECT (s->>'id')::uuid FROM jsonb_array_elements(u.active_sessions) s
              WHERE (s->>'expiresAt')::timestamptz > NOW() ORDER BY (s->>'createdAt')::timestamptz DESC LIMIT 1),
            active_session_expires_at = (SELECT (s->>'expiresAt')::timestamptz FROM jsonb_array_elements(u.active_sessions) s
              WHERE (s->>'expiresAt')::timestamptz > NOW() ORDER BY (s->>'createdAt')::timestamptz DESC LIMIT 1);
          ALTER TABLE users DROP CONSTRAINT users_active_sessions_limit;
        `,
          { transaction }
        );
        await queryInterface.removeColumn('users', 'active_sessions', { transaction });
      });
    } catch (error) {
      logger.error('三设备会话回退失败', { error: error.message });
      throw error;
    }
  },
};
