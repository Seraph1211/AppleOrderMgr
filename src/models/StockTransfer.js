const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockTransfer',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      fromLocationId: { type: DataTypes.UUID, allowNull: true, field: 'from_location_id' },
      originLabel: { type: DataTypes.STRING(200), allowNull: true, field: 'origin_label' },
      toLocationId: { type: DataTypes.UUID, allowNull: false, field: 'to_location_id' },
      status: {
        type: DataTypes.STRING(24),
        allowNull: false,
        defaultValue: 'draft',
        field: 'status',
      },
      handlerId: { type: DataTypes.UUID, allowNull: false, field: 'handler_id' },
      dispatchedAt: { type: DataTypes.DATE, allowNull: true, field: 'dispatched_at' },
      receivedAt: { type: DataTypes.DATE, allowNull: true, field: 'received_at' },
      notesCiphertext: { type: DataTypes.TEXT, allowNull: true, field: 'notes_ciphertext' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_transfers', underscored: true, timestamps: true }
  );
