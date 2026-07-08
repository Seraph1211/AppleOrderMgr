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

    // 2. 同步模型到数据库（开发环境使用）
    // 注意：生产环境应该使用迁移文件
    if (process.env.NODE_ENV === 'development') {
      logger.info('同步数据库模型...');
      await sequelize.sync({ alter: true });
      logger.info('数据库模型同步完成！');
    }

    logger.info('数据库初始化完成！');
    process.exit(0);
  } catch (error) {
    logger.error('数据库初始化失败', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// 执行初始化
initDatabase();
