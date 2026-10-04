const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockAttachment',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      kind: { type: DataTypes.STRING(24), allowNull: false, field: 'kind' },
      objectKey: { type: DataTypes.STRING(500), allowNull: false, field: 'object_key' },
      originalName: { type: DataTypes.STRING(255), allowNull: false, field: 'original_name' },
      contentType: { type: DataTypes.STRING(100), allowNull: false, field: 'content_type' },
      sizeBytes: { type: DataTypes.BIGINT, allowNull: false, field: 'size_bytes' },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'prepared',
        field: 'status',
      },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_attachments', underscored: true, timestamps: true }
  );
