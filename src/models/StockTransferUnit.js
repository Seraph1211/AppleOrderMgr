const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockTransferUnit',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      transferId: { type: DataTypes.UUID, allowNull: false, field: 'transfer_id' },
      stockUnitId: { type: DataTypes.UUID, allowNull: false, field: 'stock_unit_id' },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'planned',
        field: 'status',
      },
      receivedAt: { type: DataTypes.DATE, allowNull: true, field: 'received_at' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_transfer_units', underscored: true, timestamps: true }
  );
