const { DataTypes } = require('sequelize');
const { encryptJson, decryptJson } = require('../utils/fieldEncryption');
/** 定义 AosRecord 持久化模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'AosRecord',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
      eventId: { type: DataTypes.UUID, allowNull: false, field: 'event_id' },
      payloadHash: { type: DataTypes.STRING(64), allowNull: false, field: 'payload_hash' },
      payload: {
        type: DataTypes.JSONB,
        allowNull: false,
        field: 'payload',
        set(value) {
          this.setDataValue('payload', encryptJson(value));
        },
        get() {
          return decryptJson(this.getDataValue('payload'));
        },
      },
      draft: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'draft',
        set(value) {
          this.setDataValue('draft', encryptJson(value));
        },
        get() {
          return decryptJson(this.getDataValue('draft'));
        },
      },
      safePreview: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
        field: 'safe_preview',
      },
      fileName: { type: DataTypes.STRING(255), allowNull: false, field: 'file_name' },
      lineNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'line_number' },
      orderNumber: { type: DataTypes.STRING(11), allowNull: true, field: 'order_number' },
      orderDate: { type: DataTypes.DATE, allowNull: true, field: 'order_date' },
      receivedAt: { type: DataTypes.DATE, allowNull: false, field: 'received_at' },
      status: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'received',
        field: 'status',
      },
      eligibleAt: { type: DataTypes.DATE, allowNull: true, field: 'eligible_at' },
      eligibility: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'out_of_range',
        field: 'eligibility',
      },
      orderId: { type: DataTypes.INTEGER, allowNull: true, field: 'order_id' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version' },
      attemptCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'attempt_count',
      },
      nextRetryAt: { type: DataTypes.DATE, allowNull: true, field: 'next_retry_at' },
      leaseUntil: { type: DataTypes.DATE, allowNull: true, field: 'lease_until' },
      leaseToken: { type: DataTypes.UUID, allowNull: true, field: 'lease_token' },
      issues: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'issues' },
      errorCode: { type: DataTypes.STRING(100), allowNull: true, field: 'error_code' },
      history: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'history' },
      outcome: { type: DataTypes.STRING(30), allowNull: true, field: 'outcome' },
    },
    { tableName: 'aos_records', underscored: true, timestamps: true }
  );
