const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockProduct',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      modelKey: { type: DataTypes.STRING(80), allowNull: false, field: 'model_key' },
      modelName: { type: DataTypes.STRING(100), allowNull: false, field: 'model_name' },
      storageGb: { type: DataTypes.INTEGER, allowNull: false, field: 'storage_gb' },
      colorKey: { type: DataTypes.STRING(64), allowNull: false, field: 'color_key' },
      colorName: { type: DataTypes.STRING(64), allowNull: false, field: 'color_name' },
      skuCode: { type: DataTypes.STRING(64), allowNull: true, field: 'sku_code' },
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
    { tableName: 'stock_products', underscored: true, timestamps: true }
  );
