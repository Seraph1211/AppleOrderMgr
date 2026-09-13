const { DataTypes } = require('sequelize');
/** 定义采集器升级任务。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'CollectorUpdateJob',
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
      releaseVersion: { type: DataTypes.STRING(32), allowNull: false, field: 'release_version' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
      errorCode: { type: DataTypes.STRING(80), allowNull: true, field: 'error_code' },
      agentVersion: { type: DataTypes.STRING(32), allowNull: true, field: 'agent_version' },
      actorId: { type: DataTypes.INTEGER, allowNull: false, field: 'actor_id' },
    },
    { tableName: 'collector_update_jobs', underscored: true, timestamps: true }
  );
