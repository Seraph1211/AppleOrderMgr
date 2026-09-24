const { DataTypes } = require('sequelize');

/** 定义公开报价单例设置。 @param {Object} sequelize 数据库连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'QuotePricingSetting',
    {
      id: { type: DataTypes.SMALLINT, allowNull: false, primaryKey: true },
      publicEnabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'public_enabled',
      },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      displayOrder: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        field: 'display_order',
      },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'quote_pricing_settings', underscored: true, timestamps: true }
  );
