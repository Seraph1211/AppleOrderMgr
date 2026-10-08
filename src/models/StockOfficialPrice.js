const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockOfficialPrice',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      validFrom: { type: DataTypes.DATEONLY, allowNull: false, field: 'valid_from' },
      validTo: { type: DataTypes.DATEONLY, allowNull: true, field: 'valid_to' },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'amount' },
      sourceLabel: { type: DataTypes.STRING(200), allowNull: false, field: 'source_label' },
      sourceVersion: { type: DataTypes.STRING(100), allowNull: false, field: 'source_version' },
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        field: 'is_active',
      },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_official_prices', underscored: true, timestamps: true }
  );
