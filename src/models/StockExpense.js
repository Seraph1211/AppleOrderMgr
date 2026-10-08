const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockExpense',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      saleId: { type: DataTypes.UUID, allowNull: false, field: 'sale_id' },
      category: { type: DataTypes.STRING(24), allowNull: false, field: 'category' },
      scope: { type: DataTypes.STRING(24), allowNull: false, field: 'scope' },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'amount' },
      occurredAt: { type: DataTypes.DATE, allowNull: false, field: 'occurred_at' },
      paidByPartyId: { type: DataTypes.UUID, allowNull: true, field: 'paid_by_party_id' },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'active',
        field: 'status',
      },
      notesCiphertext: { type: DataTypes.TEXT, allowNull: true, field: 'notes_ciphertext' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_expenses', underscored: true, timestamps: true }
  );
