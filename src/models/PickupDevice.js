const { DataTypes } = require('sequelize');

/** 定义逐台扫码绑定的设备；号码全局唯一，重扫不得覆盖已有归属。 */
module.exports = sequelize => {
  const PickupDevice = sequelize.define(
    'PickupDevice',
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      stockUnitId: { type: DataTypes.UUID, allowNull: true, unique: true, field: 'stock_unit_id' },
      orderId: { type: DataTypes.INTEGER, allowNull: false, field: 'order_id' },
      serialNumber: {
        type: DataTypes.STRING(12),
        allowNull: false,
        unique: true,
        field: 'serial_number',
      },
      imei: { type: DataTypes.STRING(15), allowNull: true, unique: true },
      serialBarcode: { type: DataTypes.STRING(64), allowNull: false, field: 'serial_barcode' },
      imeiBarcode: { type: DataTypes.STRING(64), allowNull: true, field: 'imei_barcode' },
      scannedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'scanned_by' },
    },
    { tableName: 'pickup_devices', underscored: true, timestamps: true, updatedAt: false }
  );
  PickupDevice.associate = models => {
    PickupDevice.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    PickupDevice.belongsTo(models.User, { foreignKey: 'scannedBy', as: 'scanner' });
  };
  return PickupDevice;
};
