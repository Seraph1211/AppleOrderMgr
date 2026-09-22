const { DataTypes } = require('sequelize');

/** 定义订单取货业务记录，一笔订单至多一条。 */
module.exports = sequelize => {
  const PickupRecord = sequelize.define(
    'PickupRecord',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      orderId: { type: DataTypes.INTEGER, allowNull: false, unique: true, field: 'order_id' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
      pickedUpAt: { type: DataTypes.DATE, allowNull: true, field: 'picked_up_at' },
      settlementAmount: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
        field: 'settlement_amount',
      },
      settlementPerson: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'settlement_person',
      },
      notes: { type: DataTypes.TEXT, allowNull: true },
      lastUpdatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'last_updated_by' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'pickup_records', underscored: true, timestamps: true }
  );
  PickupRecord.associate = models => {
    PickupRecord.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    PickupRecord.belongsTo(models.User, { foreignKey: 'lastUpdatedBy', as: 'lastUpdater' });
    PickupRecord.hasMany(models.PickupEvidence, { foreignKey: 'pickupRecordId', as: 'evidence' });
    PickupRecord.hasMany(models.PickupRecordEvent, { foreignKey: 'pickupRecordId', as: 'events' });
  };
  return PickupRecord;
};
