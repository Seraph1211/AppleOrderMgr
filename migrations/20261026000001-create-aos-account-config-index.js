module.exports = {
  /** 新增独立日志账号索引，不修改既有日志、订单或通知数据。 @param {Object} queryInterface 接口 @param {Object} Sequelize 类型 @returns {Promise<void>} 完成 */
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.sequelize.query(
            `
            CREATE TABLE aos_account_registries (
              id varchar(64) PRIMARY KEY, device_id uuid NOT NULL, local_id uuid NOT NULL,
              account_number varchar(64) NOT NULL CHECK(account_number ~ '^[0-9]{1,64}$'), first_seen_at timestamptz NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
              UNIQUE(device_id,local_id,account_number));
            CREATE TABLE aos_account_config_events (
              id varchar(200) PRIMARY KEY, device_id uuid NOT NULL, local_id uuid NOT NULL,
              account_number varchar(64) NOT NULL CHECK(account_number ~ '^[0-9]{1,64}$'), file_id uuid NOT NULL, byte_offset bigint NOT NULL,
              line_index integer NOT NULL, logged_at timestamptz NOT NULL, kind varchar(16) NOT NULL CHECK(kind IN ('start','city','signal')),
              body jsonb NOT NULL, payload_hash varchar(64) NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
            CREATE INDEX aos_account_events_latest ON aos_account_config_events(device_id,local_id,account_number,logged_at DESC);
            CREATE INDEX aos_account_events_scope ON aos_account_config_events(device_id,local_id,logged_at);
            CREATE TABLE aos_account_index_states (
              id varchar(64) PRIMARY KEY, device_id uuid NOT NULL, local_id uuid NOT NULL,
              status varchar(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','ready','incomplete','error')), body jsonb NOT NULL DEFAULT '{}',
              created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
              UNIQUE(device_id,local_id));`,
            { transaction }
          );
        } catch (error) {
          throw new Error('AOS_ACCOUNT_INDEX_MIGRATION_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('AOS_ACCOUNT_INDEX_MIGRATION_FAILED', { cause: error });
    }
  },
  /** 回退仅删除本迁移三表，正式回滚应保留索引数据。 @param {Object} queryInterface 接口 @returns {Promise<void>} 完成 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          for (const name of [
            'aos_account_index_states',
            'aos_account_config_events',
            'aos_account_registries',
          ])
            await queryInterface.dropTable(name, { transaction });
        } catch (error) {
          throw new Error('AOS_ACCOUNT_INDEX_DOWN_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('AOS_ACCOUNT_INDEX_DOWN_FAILED', { cause: error });
    }
  },
};
