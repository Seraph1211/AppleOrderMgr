/** 按账号固化人工刷新范围；旧队列保留审计并暂停，不自动重放。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.sequelize.query(
            `ALTER TABLE official_order_refresh_batches
               ADD COLUMN selected_count INTEGER CHECK (selected_count >= 0),
               ADD COLUMN submission_summary JSONB NOT NULL DEFAULT '{}';
             ALTER TABLE official_order_refresh_jobs
               ADD COLUMN account_key VARCHAR(64),
               ADD COLUMN account_group_id UUID;
             CREATE INDEX official_refresh_account_group
               ON official_order_refresh_jobs(account_group_id,state);
             CREATE INDEX official_refresh_active_account
               ON official_order_refresh_jobs(account_key) WHERE state IN ('queued','running');
             CREATE INDEX orders_official_account ON orders(lower(btrim(apple_id)));
             UPDATE official_order_refresh_batches b
               SET paused_at=now(),pause_reason='LEGACY_ACCOUNT_SCOPE'
               WHERE b.paused_at IS NULL AND EXISTS (
                 SELECT 1 FROM official_order_refresh_jobs j
                 WHERE j.batch_id=b.id AND j.state='queued');`,
            { transaction }
          );
        } catch (error) {
          throw new Error('官网账号分组迁移事务失败', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('官网账号分组迁移失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        try {
          await queryInterface.sequelize.query(
            `LOCK TABLE official_order_refresh_jobs IN ACCESS EXCLUSIVE MODE;
             DO $$ BEGIN
               IF EXISTS (SELECT 1 FROM official_order_refresh_jobs
                          WHERE account_group_id IS NOT NULL) THEN
                 RAISE EXCEPTION '保留账号分组审计；仅回滚应用并停止 Worker';
               END IF;
             END $$;
             DROP INDEX orders_official_account, official_refresh_active_account,
               official_refresh_account_group;
             ALTER TABLE official_order_refresh_jobs DROP COLUMN account_key,
               DROP COLUMN account_group_id;
             ALTER TABLE official_order_refresh_batches DROP COLUMN selected_count,
               DROP COLUMN submission_summary;`,
            { transaction }
          );
        } catch (error) {
          throw new Error('官网账号分组回滚事务失败', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('官网账号分组迁移回滚失败', { cause: error });
    }
  },
};
