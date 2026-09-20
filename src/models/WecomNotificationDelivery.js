const { DataTypes } = require('sequelize');

/** 定义企微通知持久化模型。 @param {Object} sequelize 数据库连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'WecomNotificationDelivery',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      orderId: { type: DataTypes.INTEGER, allowNull: true, field: 'order_id' },
      destinationId: { type: DataTypes.UUID, allowNull: false, field: 'destination_id' },
      groupName: { type: DataTypes.STRING(100), allowNull: false, field: 'group_name' },
      kind: { type: DataTypes.STRING(10), allowNull: false, field: 'kind' },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        field: 'status',
      },
      waitUntil: { type: DataTypes.DATE, allowNull: false, field: 'wait_until' },
      notBefore: { type: DataTypes.DATE, allowNull: false, field: 'not_before' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'attempts' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version' },
      leaseToken: { type: DataTypes.UUID, allowNull: true, field: 'lease_token' },
      leaseUntil: { type: DataTypes.DATE, allowNull: true, field: 'lease_until' },
      dispatchStartedAt: { type: DataTypes.DATE, allowNull: true, field: 'dispatch_started_at' },
      sentAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_at' },
      errorCode: { type: DataTypes.STRING(50), allowNull: true, field: 'error_code' },
      requestKey: { type: DataTypes.UUID, allowNull: true, field: 'request_key' },
      actorId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_id' },
    },
    { tableName: 'wecom_notification_deliveries', underscored: true, timestamps: true }
  );
