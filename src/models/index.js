const { Sequelize } = require('sequelize');
const config = require('../config/database');

/**
 * 数据库连接和模型初始化
 * @module models/index
 * @description 统一管理所有Sequelize模型，建立模型关联关系
 */

// 创建Sequelize实例
const sequelizeOptions = {
  host: config.host,
  port: config.port,
  dialect: config.dialect,
  logging: config.logging,
  pool: config.pool,
  define: config.define,
  dialectOptions: config.dialectOptions,
};

const sequelize = config.url
  ? new Sequelize(config.url, sequelizeOptions)
  : new Sequelize(config.database, config.username, config.password, sequelizeOptions);

// 导入所有模型
const models = {
  User: require('./User')(sequelize),
  AppleId: require('./AppleId')(sequelize),
  Recipient: require('./Recipient')(sequelize),
  Order: require('./Order')(sequelize),
  EmailLog: require('./EmailLog')(sequelize),
  EmailWorkerState: require('./EmailWorkerState')(sequelize),
  CrawlLog: require('./CrawlLog')(sequelize),
  OrderRefreshSchedule: require('./OrderRefreshSchedule')(sequelize),
  OrderRefreshBatch: require('./OrderRefreshBatch')(sequelize),
  OrderRefreshJob: require('./OrderRefreshJob')(sequelize),
  OrderRefreshSystemState: require('./OrderRefreshSystemState')(sequelize),
  UserPermission: require('./UserPermission')(sequelize),
  UserPermissionEvent: require('./UserPermissionEvent')(sequelize),
  PaymentTask: require('./PaymentTask')(sequelize),
  PaymentTaskEvent: require('./PaymentTaskEvent')(sequelize),
  OrderPayerEvent: require('./OrderPayerEvent')(sequelize),
  PaymentDispatchSetting: require('./PaymentDispatchSetting')(sequelize),
  PaymentStaffSetting: require('./PaymentStaffSetting')(sequelize),
  PaymentDispatchEvent: require('./PaymentDispatchEvent')(sequelize),
};

// 建立模型关联关系
Object.keys(models).forEach(modelName => {
  if (models[modelName].associate) {
    models[modelName].associate(models);
  }
});

// 导出
module.exports = {
  sequelize,
  Sequelize,
  ...models,
};
