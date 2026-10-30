/** 根据已认证的生产 pg_indexes 定义重建缺失的历史迁移；生产已执行，本轮不重跑。 */
module.exports = {
  /** 创建已上线的账号配置只读索引。 @param {Object} queryInterface 接口 @returns {Promise<void>} 完成 */
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.query(
        `CREATE INDEX aos_account_events_config_read ON aos_account_config_events
          (device_id, local_id, account_number, logged_at DESC, byte_offset DESC, line_index DESC)
          INCLUDE (kind) WHERE kind <> 'signal'`
      );
    } catch (error) {
      throw new Error('AOS_ACCOUNT_READ_INDEX_MIGRATION_FAILED', { cause: error });
    }
  },
  /** 仅删除本迁移的派生索引。 @param {Object} queryInterface 接口 @returns {Promise<void>} 完成 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.query('DROP INDEX aos_account_events_config_read');
    } catch (error) {
      throw new Error('AOS_ACCOUNT_READ_INDEX_DOWN_FAILED', { cause: error });
    }
  },
};
