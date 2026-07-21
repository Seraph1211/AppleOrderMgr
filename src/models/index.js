const { Sequelize } = require('sequelize');
const config = require('../config/database');

/**
 * 数据库连接和模型初始化
 * @module models/index
 * @description 统一管理所有Sequelize模型，建立模型关联关系
 */

// 创建Sequelize实例
const sequelize = new Sequelize(
  config.database,
  config.username,
  config.password,
  {
    host: config.host,
    port: config.port,
    dialect: config.dialect,
    logging: config.logging,
    pool: config.pool,
    define: config.define,
    dialectOptions: config.dialectOptions
  }
);

// 导入所有模型
const models = {
  User: require('./User')(sequelize),
  AppleId: require('./AppleId')(sequelize),
  Recipient: require('./Recipient')(sequelize),
  Order: require('./Order')(sequelize),
  EmailLog: require('./EmailLog')(sequelize),
  CrawlLog: require('./CrawlLog')(sequelize)
};

// 建立模型关联关系
Object.keys(models).forEach((modelName) => {
  if (models[modelName].associate) {
    models[modelName].associate(models);
  }
});

// 导出
module.exports = {
  sequelize,
  Sequelize,
  ...models
};
