const logger = require('../src/utils/logger');

/** 为所有实物分配永久递增展示编号，保留原UUID及业务字段。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `SET LOCAL lock_timeout = '10s';
           LOCK TABLE stock_units IN ACCESS EXCLUSIVE MODE;
           ALTER TABLE stock_units ADD COLUMN device_number INTEGER;
           WITH numbered AS (
             SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id)::integer AS number
             FROM stock_units
           )
           UPDATE stock_units u SET device_number = numbered.number FROM numbered WHERE u.id = numbered.id;
           CREATE SEQUENCE stock_units_device_number_seq AS INTEGER START WITH 1;
           ALTER SEQUENCE stock_units_device_number_seq OWNED BY stock_units.device_number;
           SELECT setval('stock_units_device_number_seq', COALESCE(MAX(device_number), 1), COUNT(*) > 0) FROM stock_units;
           ALTER TABLE stock_units
             ALTER COLUMN device_number SET DEFAULT nextval('stock_units_device_number_seq'),
             ALTER COLUMN device_number SET NOT NULL,
             ADD CONSTRAINT stock_units_device_number_unique UNIQUE (device_number),
             ADD CONSTRAINT stock_units_device_number_positive CHECK (device_number > 0);`,
          { transaction }
        );
      });
    } catch (error) {
      logger.warn('设备递增编号迁移失败', { code: error.code || error.name });
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query('LOCK TABLE stock_units IN ACCESS EXCLUSIVE MODE', {
          transaction,
        });
        const [rows] = await queryInterface.sequelize.query('SELECT 1 FROM stock_units LIMIT 1', {
          transaction,
        });
        if (rows.length) throw new Error('已有设备编号，拒绝删除；请保留结构回滚应用');
        await queryInterface.removeColumn('stock_units', 'device_number', { transaction });
      });
    } catch (error) {
      logger.warn('设备递增编号回退失败', { code: error.code || error.name });
      throw error;
    }
  },
};
