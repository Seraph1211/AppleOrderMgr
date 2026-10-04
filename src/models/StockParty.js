const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockParty',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      name: { type: DataTypes.STRING(100), allowNull: false, field: 'name' },
      partyType: { type: DataTypes.STRING(24), allowNull: false, field: 'party_type' },
      roles: { type: DataTypes.JSONB, allowNull: false, field: 'roles' },
      userId: { type: DataTypes.INTEGER, allowNull: true, field: 'user_id' },
      contactCiphertext: { type: DataTypes.TEXT, allowNull: true, field: 'contact_ciphertext' },
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
    { tableName: 'stock_parties', underscored: true, timestamps: true }
  );
