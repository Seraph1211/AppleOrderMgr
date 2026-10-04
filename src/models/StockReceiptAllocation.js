const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockReceiptAllocation',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      receiptId: { type: DataTypes.UUID, allowNull: false, field: 'receipt_id' },
      collectionId: { type: DataTypes.UUID, allowNull: false, field: 'collection_id' },
      saleUnitId: { type: DataTypes.UUID, allowNull: false, field: 'sale_unit_id' },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'amount' },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'active',
        field: 'status',
      },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_receipt_allocations', underscored: true, timestamps: true }
  );
