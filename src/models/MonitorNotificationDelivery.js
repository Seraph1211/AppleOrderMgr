const { DataTypes } = require('sequelize');

/** 定义服务器监控邮件实际投递批次。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize => {
  const Model = sequelize.define(
    'MonitorNotificationDelivery',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      deviceId: { type: DataTypes.UUID, allowNull: true, field: 'device_id' },
      category: { type: DataTypes.STRING(20), allowNull: false, field: 'category' },
      severity: { type: DataTypes.STRING(20), allowNull: false, field: 'severity' },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        field: 'status',
      },
      notBefore: { type: DataTypes.DATE, allowNull: false, field: 'not_before' },
      recipientSnapshot: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        field: 'recipient_snapshot',
      },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'attempts' },
      lastError: { type: DataTypes.STRING(500), allowNull: true, field: 'last_error' },
      sentAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_at' },
    },
    { tableName: 'monitor_notification_deliveries', underscored: true, timestamps: true }
  );
  Model.associate = models => {
    Model.hasMany(models.MonitorNotificationEvent, { foreignKey: 'deliveryId', as: 'events' });
  };
  return Model;
};
