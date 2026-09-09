const { DataTypes } = require('sequelize');
const { encrypt, decrypt } = require('../utils/fieldEncryption');

/** 定义核验明细，原始字段和结果均加密存储。 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'IdentityVerificationItem',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      batchId: { type: DataTypes.UUID, allowNull: false, field: 'batch_id' },
      rowNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'row_number' },
      name: {
        type: DataTypes.TEXT,
        allowNull: false,
        set(value) {
          this.setDataValue('name', encrypt(JSON.stringify(value)));
        },
        get() {
          const value = this.getDataValue('name');
          return value == null ? value : JSON.parse(decrypt(value));
        },
      },
      idCardNumber: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'id_card_number',
        set(value) {
          this.setDataValue('idCardNumber', encrypt(JSON.stringify(value)));
        },
        get() {
          const value = this.getDataValue('idCardNumber');
          return value == null ? value : JSON.parse(decrypt(value));
        },
      },
      status: { type: DataTypes.STRING(20), allowNull: false },
      duplicateOf: { type: DataTypes.INTEGER, field: 'duplicate_of' },
      message: { type: DataTypes.STRING(255) },
      resultData: {
        type: DataTypes.TEXT,
        field: 'result_data',
        set(value) {
          this.setDataValue('resultData', value ? encrypt(JSON.stringify(value)) : null);
        },
        get() {
          const value = this.getDataValue('resultData');
          return value ? JSON.parse(decrypt(value)) : null;
        },
      },
      startedAt: { type: DataTypes.DATE, field: 'started_at' },
      finishedAt: { type: DataTypes.DATE, field: 'finished_at' },
    },
    { tableName: 'identity_verification_items', underscored: true, timestamps: true }
  );
