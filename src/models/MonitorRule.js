const { DataTypes } = require('sequelize');
/** 定义服务器监控持久化模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorRule',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version' },
      config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'config' },
    },
    { tableName: 'monitor_rules', underscored: true, timestamps: true }
  );
