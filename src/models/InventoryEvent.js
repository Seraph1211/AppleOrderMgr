const { DataTypes } = require('sequelize');

/** 定义独立库存模型 InventoryEvent。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'InventoryEvent',
    {
      id: { type: DataTypes.STRING(200), primaryKey: true, allowNull: false },
      body: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    { tableName: 'inventory_events', underscored: true, timestamps: true }
  );
