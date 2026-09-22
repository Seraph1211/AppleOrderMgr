const { DataTypes } = require('sequelize');

/** 定义取货记录的追加式修改历史。 */
module.exports = sequelize => {
  const PickupRecordEvent = sequelize.define(
    'PickupRecordEvent',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      pickupRecordId: { type: DataTypes.BIGINT, allowNull: false, field: 'pickup_record_id' },
      orderId: { type: DataTypes.INTEGER, allowNull: false, field: 'order_id' },
      actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
      actorName: { type: DataTypes.STRING(100), allowNull: false, field: 'actor_name' },
      eventType: { type: DataTypes.STRING(30), allowNull: false, field: 'event_type' },
      changes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      beforeVersion: { type: DataTypes.INTEGER, allowNull: false, field: 'before_version' },
      afterVersion: { type: DataTypes.INTEGER, allowNull: false, field: 'after_version' },
    },
    { tableName: 'pickup_record_events', underscored: true, timestamps: true, updatedAt: false }
  );
  PickupRecordEvent.associate = models => {
    PickupRecordEvent.belongsTo(models.PickupRecord, {
      foreignKey: 'pickupRecordId',
      as: 'record',
    });
    PickupRecordEvent.belongsTo(models.User, { foreignKey: 'actorUserId', as: 'actor' });
  };
  return PickupRecordEvent;
};
