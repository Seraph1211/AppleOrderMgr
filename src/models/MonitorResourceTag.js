const { DataTypes } = require('sequelize');

/** 人工服务器／实例标签，独立于采集器状态。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorResourceTag',
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
      localId: { type: DataTypes.UUID, allowNull: true, field: 'local_id' },
      tag: { type: DataTypes.STRING(100), allowNull: false, defaultValue: '' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    { tableName: 'monitor_resource_tags', underscored: true, timestamps: true }
  );
