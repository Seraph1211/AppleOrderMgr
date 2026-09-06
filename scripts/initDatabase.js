const { sequelize } = require('../src/models');
const logger = require('../src/utils/logger');

/**
 * 数据库初始化脚本
 * @description 测试数据库连接并执行迁移
 */
async function initDatabase() {
  try {
    logger.info('开始初始化数据库...');

    // 1. 测试数据库连接
    logger.info('测试数据库连接...');
    await sequelize.authenticate();
    logger.info('数据库连接成功！');

    logger.info('数据库连接验证完成；表结构请使用 npm run db:migrate 更新');
    process.exit(0);
  } catch (error) {
    logger.error('数据库初始化失败', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// 执行初始化
initDatabase();
