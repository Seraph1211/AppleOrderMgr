const { DataTypes } = require('sequelize');

/** 定义服务器监控邮件批次事件。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize => {
  const Model = sequelize.define(
    'MonitorNotificationEvent',
    {
      eventKey: { type: DataTypes.STRING(255), field: 'event_key' },
      channel: { type: DataTypes.STRING(10), field: 'channel' },
      targetVersion: { type: DataTypes.INTEGER, field: 'target_version' },
      outcome: { type: DataTypes.STRING(20), field: 'outcome' },
      reminderSequence: { type: DataTypes.INTEGER, field: 'reminder_sequence' },
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      deliveryId: { type: DataTypes.UUID, allowNull: false, field: 'delivery_id' },
      sourceKey: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
        field: 'source_key',
      },
      payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'payload' },
    },
    { tableName: 'monitor_notification_events', underscored: true, timestamps: true }
  );
  Model.associate = models => {
    Model.belongsTo(models.MonitorNotificationDelivery, {
      foreignKey: 'deliveryId',
      as: 'delivery',
    });
  };
  return Model;
};
