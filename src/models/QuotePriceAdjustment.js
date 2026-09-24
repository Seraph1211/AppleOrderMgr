const { DataTypes } = require('sequelize');

/** 定义逐商品公开报价调整。 @param {Object} sequelize 数据库连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'QuotePriceAdjustment',
    {
      productKey: {
        type: DataTypes.STRING(191),
        allowNull: false,
        primaryKey: true,
        field: 'product_key',
      },
      productModel: { type: DataTypes.STRING(32), allowNull: false, field: 'product_model' },
      storageGb: { type: DataTypes.INTEGER, allowNull: false, field: 'storage_gb' },
      color: { type: DataTypes.STRING(32), allowNull: false },
      percentage: { type: DataTypes.DECIMAL(8, 4), allowNull: false, defaultValue: 0 },
      fixedAmount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
        field: 'fixed_amount',
      },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'quote_price_adjustments', underscored: true, timestamps: true }
  );
