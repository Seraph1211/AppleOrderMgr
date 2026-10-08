/** 批次保护与执行器存活分离；回滚不得丢失暂停状态。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.query(`
        ALTER TABLE official_order_refresh_batches
          ADD COLUMN paused_at TIMESTAMPTZ,
          ADD COLUMN pause_reason VARCHAR(80),
          ADD CONSTRAINT official_refresh_pause_pair
            CHECK ((paused_at IS NULL) = (pause_reason IS NULL));
      `);
    } catch (error) {
      throw new Error('官网更新批次暂停迁移失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `LOCK TABLE official_order_refresh_batches IN ACCESS EXCLUSIVE MODE;
          DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM official_order_refresh_batches WHERE paused_at IS NOT NULL) THEN
              RAISE EXCEPTION '暂停状态必须保留；仅回滚应用并保持 Worker 停止';
            END IF;
          END $$;
          ALTER TABLE official_order_refresh_batches
            DROP CONSTRAINT official_refresh_pause_pair,
            DROP COLUMN paused_at, DROP COLUMN pause_reason;`,
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('官网更新批次暂停迁移回滚失败', { cause: error });
    }
  },
};
