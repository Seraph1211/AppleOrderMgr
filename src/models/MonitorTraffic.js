const { DataTypes } = require('sequelize');
/** 定义服务器监控持久化模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorTraffic',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
      startedAt: { type: DataTypes.DATE, allowNull: false, field: 'started_at' },
      endedAt: { type: DataTypes.DATE, allowNull: false, field: 'ended_at' },
      receivedBytes: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        field: 'received_bytes',
      },
      sentBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'sent_bytes' },
      collectorReceivedBytes: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        field: 'collector_received_bytes',
      },
      collectorSentBytes: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        field: 'collector_sent_bytes',
      },
      quality: { type: DataTypes.STRING(20), allowNull: false, field: 'quality' },
      payloadHash: { type: DataTypes.STRING(64), allowNull: false, field: 'payload_hash' },
    },
    { tableName: 'monitor_traffic', underscored: true, timestamps: true }
  );
