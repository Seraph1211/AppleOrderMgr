'use strict';

/** 保留历史 IMEI，允许新登记仅保存序列号；回退遇到空值时原子失败。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.query(`ALTER TABLE pickup_devices
        ALTER COLUMN imei DROP NOT NULL,
        ALTER COLUMN imei_barcode DROP NOT NULL`);
    } catch (error) {
      throw new Error('调整设备序列号登记失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.query(`ALTER TABLE pickup_devices
        ALTER COLUMN imei SET NOT NULL,
        ALTER COLUMN imei_barcode SET NOT NULL`);
    } catch (error) {
      throw new Error('存在仅序列号记录时不可回退 IMEI 非空约束', { cause: error });
    }
  },
};
