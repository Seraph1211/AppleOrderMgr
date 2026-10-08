'use strict';
const logger = require('../src/utils/logger');

async function alter(queryInterface, sql) {
  try {
    await queryInterface.sequelize.transaction(async transaction => {
      try {
        await queryInterface.sequelize.query(
          "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5s'",
          { transaction }
        );
        await queryInterface.sequelize.query(sql, { transaction });
      } catch (error) {
        logger.warn('日志周期辅助列迁移失败', { errorCode: error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.warn('日志周期辅助列迁移未完成', { errorCode: error.name });
    throw error;
  }
}

module.exports = {
  /** 仅新增可空无默认辅助列，不回填载荷。 @param {Object} queryInterface 接口 @returns {Promise<void>} 结果 */
  async up(queryInterface) {
    try {
      await alter(queryInterface, 'ALTER TABLE monitor_log_blocks ADD COLUMN repeat_limits jsonb');
    } catch (error) {
      logger.debug('日志辅助列操作未完成', { errorCode: error.name });
      throw error;
    }
  },
  /** 读取/写入代码先回退兼容版本；仅删除派生列。 @param {Object} queryInterface 接口 @returns {Promise<void>} 结果 */
  async down(queryInterface) {
    try {
      await alter(queryInterface, 'ALTER TABLE monitor_log_blocks DROP COLUMN repeat_limits');
    } catch (error) {
      logger.debug('日志辅助列操作未完成', { errorCode: error.name });
      throw error;
    }
  },
};
