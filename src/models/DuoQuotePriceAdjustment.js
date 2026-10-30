const { DataTypes } = require('sequelize');

/** 定义独立Duo逐款加价，只保存加价不固定零售价。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'DuoQuotePriceAdjustment',
    {
      productKey: {
        type: DataTypes.STRING(40),
        allowNull: false,
        primaryKey: true,
        field: 'product_key',
      },
      productModel: { type: DataTypes.STRING(32), allowNull: false, field: 'product_model' },
      storageGb: { type: DataTypes.INTEGER, allowNull: false, field: 'storage_gb' },
      color: { type: DataTypes.STRING(32), allowNull: false },
      markup: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 50 },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'duo_quote_price_adjustments', underscored: true, timestamps: true }
  );
