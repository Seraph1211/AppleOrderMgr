const { DataTypes } = require('sequelize');

/** 定义存放于私有对象存储中的取货或结款凭证元数据。 */
module.exports = sequelize => {
  const PickupEvidence = sequelize.define(
    'PickupEvidence',
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      pickupRecordId: { type: DataTypes.BIGINT, allowNull: false, field: 'pickup_record_id' },
      kind: { type: DataTypes.STRING(20), allowNull: false },
      objectKey: {
        type: DataTypes.STRING(500),
        allowNull: false,
        unique: true,
        field: 'object_key',
      },
      originalName: { type: DataTypes.STRING(255), allowNull: false, field: 'original_name' },
      contentType: { type: DataTypes.STRING(100), allowNull: false, field: 'content_type' },
      sizeBytes: { type: DataTypes.BIGINT, allowNull: false, field: 'size_bytes' },
      uploadedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'uploaded_by' },
    },
    { tableName: 'pickup_evidence', underscored: true, timestamps: true, updatedAt: false }
  );
  PickupEvidence.associate = models => {
    PickupEvidence.belongsTo(models.PickupRecord, { foreignKey: 'pickupRecordId', as: 'record' });
    PickupEvidence.belongsTo(models.User, { foreignKey: 'uploadedBy', as: 'uploader' });
  };
  return PickupEvidence;
};
