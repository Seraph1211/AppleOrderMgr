const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockAttachmentLink',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      attachmentId: { type: DataTypes.UUID, allowNull: false, field: 'attachment_id' },
      unitId: { type: DataTypes.UUID, allowNull: true, field: 'unit_id' },
      saleId: { type: DataTypes.UUID, allowNull: true, field: 'sale_id' },
      collectionId: { type: DataTypes.UUID, allowNull: true, field: 'collection_id' },
      receiptId: { type: DataTypes.UUID, allowNull: true, field: 'receipt_id' },
      expenseId: { type: DataTypes.UUID, allowNull: true, field: 'expense_id' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_attachment_links', underscored: true, timestamps: true }
  );
