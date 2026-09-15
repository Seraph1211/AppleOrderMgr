const { DataTypes } = require('sequelize');

/** 定义服务器监控邮件通知设置。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorNotificationSetting',
    {
      id: { type: DataTypes.SMALLINT, allowNull: false, primaryKey: true, field: 'id' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'enabled' },
      recipients: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        field: 'recipients',
      },
      sendRecovery: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'send_recovery',
      },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'monitor_notification_settings', underscored: true, timestamps: true }
  );
