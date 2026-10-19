const { DataTypes } = require('sequelize');

/** 定义通知持久化模型。 @param {Object} sequelize 数据库 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorNotificationLink',
    {
      id: { type: DataTypes.UUID, primaryKey: true, field: 'id' },
      alertId: { type: DataTypes.UUID, field: 'alert_id' },
      channel: { type: DataTypes.STRING(10), field: 'channel' },
      targetVersion: { type: DataTypes.INTEGER, field: 'target_version' },
      initialStatus: { type: DataTypes.STRING(20), field: 'initial_status' },
      lastNotifiedAt: { type: DataTypes.DATE, field: 'last_notified_at' },
      reminderSequence: { type: DataTypes.INTEGER, field: 'reminder_sequence' },
      nextReminderAt: { type: DataTypes.DATE, field: 'next_reminder_at' },
      recoveryQueuedAt: { type: DataTypes.DATE, field: 'recovery_queued_at' },
    },
    { tableName: 'monitor_notification_links', underscored: true, timestamps: true }
  );
