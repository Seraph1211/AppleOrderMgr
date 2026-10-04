const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockImportJob',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      kind: { type: DataTypes.STRING(24), allowNull: false, field: 'kind' },
      fileHash: { type: DataTypes.CHAR(64), allowNull: false, field: 'file_hash' },
      previewHash: { type: DataTypes.CHAR(64), allowNull: false, field: 'preview_hash' },
      sourceLabel: { type: DataTypes.STRING(100), allowNull: false, field: 'source_label' },
      payloadCiphertext: { type: DataTypes.JSONB, allowNull: false, field: 'payload_ciphertext' },
      resultRefs: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
        field: 'result_refs',
      },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'preview',
        field: 'status',
      },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'version' },
      createdBy: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'stock_import_jobs', underscored: true, timestamps: true }
  );
