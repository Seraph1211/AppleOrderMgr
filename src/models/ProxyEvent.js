const { DataTypes } = require('sequelize');
/** 定义脱敏业务事件。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'ProxyEvent',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      proxyOrderId: DataTypes.INTEGER,
      actorId: DataTypes.INTEGER,
      action: DataTypes.STRING(60),
      detail: DataTypes.JSONB,
      createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    },
    { tableName: 'proxy_events', underscored: true, timestamps: false }
  );
