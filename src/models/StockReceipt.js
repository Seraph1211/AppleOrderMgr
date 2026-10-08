const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockReceipt',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      source: { type: DataTypes.STRING(24), allowNull: false, field: 'source' },
      payerId: { type: DataTypes.UUID, allowNull: true, field: 'payer_id' },
      collectionId: { type: DataTypes.UUID, allowNull: true, field: 'collection_id' },
      amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, field: 'amount' },
      receivedAt: { type: DataTypes.DATE, allowNull: true, field: 'received_at' },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'posted',
        field: 'status',
      },
      externalRecordKey: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'external_record_key',
      },
      notesCiphertext: { type: DataTypes.TEXT, allowNull: true, field: 'notes_ciphertext' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_receipts', underscored: true, timestamps: true }
  );
