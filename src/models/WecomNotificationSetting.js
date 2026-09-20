const { DataTypes } = require('sequelize');

/** 定义企微通知持久化模型。 @param {Object} sequelize 数据库连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'WecomNotificationSetting',
    {
      id: { type: DataTypes.SMALLINT, allowNull: false, primaryKey: true, field: 'id' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'enabled' },
      groupName: {
        type: DataTypes.STRING(100),
        allowNull: false,
        defaultValue: '',
        field: 'group_name',
      },
      webhookCipher: { type: DataTypes.TEXT, allowNull: true, field: 'webhook_cipher' },
      destinationId: { type: DataTypes.UUID, allowNull: false, field: 'destination_id' },
      enabledAt: { type: DataTypes.DATE, allowNull: true, field: 'enabled_at' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version' },
      nextSendAt: { type: DataTypes.DATE, allowNull: true, field: 'next_send_at' },
      pausedReason: { type: DataTypes.STRING(50), allowNull: true, field: 'paused_reason' },
      workerHeartbeatAt: { type: DataTypes.DATE, allowNull: true, field: 'worker_heartbeat_at' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'wecom_notification_settings', underscored: true, timestamps: true }
  );
