const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockSaleUnit',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      saleLineId: { type: DataTypes.UUID, allowNull: false, field: 'sale_line_id' },
      stockUnitId: { type: DataTypes.UUID, allowNull: false, field: 'stock_unit_id' },
      fromLocationId: { type: DataTypes.UUID, allowNull: true, field: 'from_location_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, field: 'status' },
      saleAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: true, field: 'sale_amount' },
      costAmountSnapshot: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
        field: 'cost_amount_snapshot',
      },
      productSnapshot: { type: DataTypes.JSONB, allowNull: false, field: 'product_snapshot' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_sale_units', underscored: true, timestamps: true }
  );
