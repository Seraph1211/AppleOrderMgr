const { DataTypes } = require('sequelize');
/** 完整日志扫描覆盖与队列状态。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorLogState',
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
      localId: { type: DataTypes.UUID, allowNull: false, field: 'local_id' },
      label: { type: DataTypes.STRING(100), allowNull: false },
      observedAt: { type: DataTypes.DATE, allowNull: false, field: 'observed_at' },
      snapshot: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    { tableName: 'monitor_log_states', underscored: true, timestamps: true }
  );
