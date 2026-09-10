const { DataTypes } = require('sequelize');
/** 定义 PickupStore 持久化模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'PickupStore',
    {
      code: { type: DataTypes.STRING(50), allowNull: false, primaryKey: true, field: 'code' },
      name: { type: DataTypes.STRING(100), allowNull: false, field: 'name' },
      city: { type: DataTypes.STRING(100), allowNull: true, field: 'city' },
      sourceUrl: { type: DataTypes.STRING(2048), allowNull: false, field: 'source_url' },
      verifiedAt: { type: DataTypes.DATE, allowNull: false, field: 'verified_at' },
    },
    { tableName: 'pickup_stores', underscored: true, timestamps: true }
  );
