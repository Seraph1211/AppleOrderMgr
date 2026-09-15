const { DataTypes } = require('sequelize');
/** 定义服务器监控持久化模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorInstance',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
      localId: { type: DataTypes.UUID, allowNull: false, field: 'local_id' },
      label: { type: DataTypes.STRING(100), allowNull: false, field: 'label' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'active' },
      observedAt: { type: DataTypes.DATE, allowNull: true, field: 'observed_at' },
      snapshot: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'snapshot' },
      handling: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'handling' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version' },
    },
    { tableName: 'monitor_instances', underscored: true, timestamps: true }
  );
