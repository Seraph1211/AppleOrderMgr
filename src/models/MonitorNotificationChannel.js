const { DataTypes } = require('sequelize');

/** 定义通知持久化模型。 @param {Object} sequelize 数据库 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorNotificationChannel',
    {
      channel: { type: DataTypes.STRING(10), primaryKey: true, field: 'channel' },
      enabled: { type: DataTypes.BOOLEAN, field: 'enabled' },
      recipients: { type: DataTypes.JSONB, field: 'recipients' },
      sendRecovery: { type: DataTypes.BOOLEAN, field: 'send_recovery' },
      webhookCipher: { type: DataTypes.TEXT, field: 'webhook_cipher' },
      targetName: { type: DataTypes.STRING(100), field: 'target_name' },
      targetVersion: { type: DataTypes.INTEGER, field: 'target_version' },
      policyVersion: { type: DataTypes.INTEGER, field: 'policy_version' },
      policy: { type: DataTypes.JSONB, field: 'policy' },
      version: { type: DataTypes.INTEGER, field: 'version' },
      enabledAt: { type: DataTypes.DATE, field: 'enabled_at' },
      pausedReason: { type: DataTypes.STRING(100), field: 'paused_reason' },
      lastTest: { type: DataTypes.JSONB, field: 'last_test' },
      lastAcceptedAt: { type: DataTypes.DATE, field: 'last_accepted_at' },
      updatedBy: { type: DataTypes.INTEGER, field: 'updated_by' },
      senderGeneration: { type: DataTypes.INTEGER, field: 'sender_generation' },
    },
    { tableName: 'monitor_notification_channels', underscored: true, timestamps: true }
  );
