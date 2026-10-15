/* eslint-disable camelcase -- Migration使用数据库列名 */
module.exports = {
  /** 创建内部核验令牌、保护状态与审计。 @returns {Promise<void>} 完成 */
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `
          CREATE TABLE identity_api_tokens (
            id UUID PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            token_hash VARCHAR(64) NOT NULL UNIQUE, token_ciphertext TEXT NOT NULL,
            prefix VARCHAR(16) NOT NULL, status VARCHAR(10) NOT NULL CHECK(status IN ('active','revoked')),
            expires_at TIMESTAMPTZ NOT NULL, last_used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE UNIQUE INDEX identity_api_token_active_user ON identity_api_tokens(user_id) WHERE status='active';
          CREATE TABLE identity_api_usage (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            kind VARCHAR(10) NOT NULL CHECK(kind IN ('minute','day')), period VARCHAR(24) NOT NULL,
            count INTEGER NOT NULL DEFAULT 0 CHECK(count>=0), PRIMARY KEY(user_id,kind,period)
          );
          CREATE TABLE identity_service_state (
            id INTEGER PRIMARY KEY CHECK(id=1), paused BOOLEAN NOT NULL DEFAULT FALSE,
            pause_reason VARCHAR(255), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          INSERT INTO identity_service_state(id) VALUES(1);
          CREATE TABLE identity_api_dedup (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            request_hash VARCHAR(64) NOT NULL,
            item_id INTEGER NOT NULL REFERENCES identity_verification_items(id) ON DELETE RESTRICT,
            PRIMARY KEY(user_id,request_hash)
          );
          CREATE INDEX identity_api_dedup_item ON identity_api_dedup(item_id);
          CREATE TABLE identity_api_events (
            id BIGSERIAL PRIMARY KEY, actor_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
            action VARCHAR(40) NOT NULL, token_id UUID REFERENCES identity_api_tokens(id) ON DELETE RESTRICT,
            item_id INTEGER REFERENCES identity_verification_items(id) ON DELETE RESTRICT,
            reason VARCHAR(255), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          ALTER TABLE identity_verification_batches ADD COLUMN api_token_id UUID REFERENCES identity_api_tokens(id) ON DELETE RESTRICT;
          ALTER TABLE identity_verification_batches DROP CONSTRAINT identity_batch_source;
          ALTER TABLE identity_verification_batches ADD CONSTRAINT identity_batch_source CHECK(source IN ('single','excel','api'));
        `,
          { transaction }
        );
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error('内部核验迁移失败');
    }
  },
  /** 没有API历史时可回退结构，存在历史拒绝破坏审计。 @returns {Promise<void>} 完成 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        const [rows] = await queryInterface.sequelize.query(
          "SELECT 1 FROM identity_verification_batches WHERE source='api' LIMIT 1",
          { transaction }
        );
        if (rows.length) throw new Error('存在API核验历史，禁止删除审计；请仅回退代码');
        await queryInterface.sequelize.query(
          `
          ALTER TABLE identity_verification_batches DROP CONSTRAINT identity_batch_source;
          ALTER TABLE identity_verification_batches ADD CONSTRAINT identity_batch_source CHECK(source IN ('single','excel'));
          ALTER TABLE identity_verification_batches DROP COLUMN api_token_id;
          DROP TABLE identity_api_events;
          DROP TABLE identity_api_dedup;
          DROP TABLE identity_api_usage;
          DROP TABLE identity_service_state;
          DROP TABLE identity_api_tokens;
        `,
          { transaction }
        );
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error('内部核验回退失败');
    }
  },
};
