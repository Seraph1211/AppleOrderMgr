const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockLocation',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      name: { type: DataTypes.STRING(100), allowNull: false, field: 'name' },
      kind: { type: DataTypes.STRING(16), allowNull: false, field: 'kind' },
      city: { type: DataTypes.STRING(50), allowNull: false, field: 'city' },
      partyId: { type: DataTypes.UUID, allowNull: true, field: 'party_id' },
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
    { tableName: 'stock_locations', underscored: true, timestamps: true }
  );
