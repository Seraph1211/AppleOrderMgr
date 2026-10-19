const { DataTypes } = require('sequelize');

/** 定义通知持久化模型。 @param {Object} sequelize 数据库 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'NotificationWorkerState',
    {
      lane: { type: DataTypes.STRING(20), primaryKey: true, field: 'lane' },
      heartbeatAt: { type: DataTypes.DATE, field: 'heartbeat_at' },
      lastSuccessAt: { type: DataTypes.DATE, field: 'last_success_at' },
      errorCode: { type: DataTypes.STRING(100), field: 'error_code' },
      details: { type: DataTypes.JSONB, field: 'details' },
    },
    { tableName: 'notification_worker_states', underscored: true, timestamps: true }
  );
