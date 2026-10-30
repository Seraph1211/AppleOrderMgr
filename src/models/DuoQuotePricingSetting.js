const { DataTypes } = require('sequelize');

/** 定义独立Duo报价设置；初始化不产生人工报价时间。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'DuoQuotePricingSetting',
    {
      id: { type: DataTypes.SMALLINT, allowNull: false, primaryKey: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      pricingUpdatedAt: { type: DataTypes.DATE, allowNull: true, field: 'pricing_updated_at' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'duo_quote_pricing_settings', underscored: true, timestamps: true }
  );
