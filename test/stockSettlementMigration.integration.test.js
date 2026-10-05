/** 新结算字段迁移在独立无业务资料库验证。 */
const logger = require('../src/utils/logger');
const { Sequelize } = require('sequelize');
const enabled = process.env.RUN_STOCK_SETTLEMENT_MIGRATION === 'true';
if (
  enabled &&
  (process.env.DB_NAME !== 'apple_order_mgr_stock_test_1009' ||
    process.env.DB_NAME_TEST !== process.env.DB_NAME ||
    process.env.DATABASE_URL)
)
  throw new Error('结算迁移测试只允许独立合成库1009');
(enabled ? describe : describe.skip)('结算字段正式迁移', () => {
  const migration = require('../migrations/20261005000003-add-stock-settlement');
  const config = require('../config/config').test;
  const sequelize = new Sequelize(config.database, config.username, config.password, {
    ...config,
    logging: false,
  });
  const qi = sequelize.getQueryInterface();
  afterAll(async () => {
    try {
      await sequelize.close();
    } catch (error) {
      logger.warn('合成迁移连接关闭失败', { name: error.name });
      throw error;
    }
  });
  test('空字段up/down/up、保留旧列与有限金额约束', async () => {
    const [before] = await sequelize.query('SELECT count(*)::integer n FROM stock_sale_units');
    await migration.up(qi);
    expect((await qi.describeTable('stock_sale_units')).settlement_amount.allowNull).toBe(true);
    await migration.down(qi);
    expect((await qi.describeTable('stock_sale_units')).settlement_amount).toBeUndefined();
    await migration.up(qi);
    const [after] = await sequelize.query('SELECT count(*)::integer n FROM stock_sale_units');
    expect(after).toEqual(before);
    const [constraints] = await sequelize.query(
      "SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='stock_sale_units_settlement_check'"
    );
    expect(constraints[0].definition).toContain('NaN');
  });
});
