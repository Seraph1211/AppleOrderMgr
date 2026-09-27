'use strict';

/** 持久化 OCR 月度调用预占次数，部署重启不重置预算。 */
module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.sequelize.query(`CREATE TABLE ocr_monthly_usage (
        month VARCHAR(7) PRIMARY KEY,
        used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0)
      )`);
    } catch (error) {
      throw new Error('创建 OCR 月度额度表失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.dropTable('ocr_monthly_usage');
    } catch (error) {
      throw new Error('回退 OCR 月度额度表失败', { cause: error });
    }
  },
};
