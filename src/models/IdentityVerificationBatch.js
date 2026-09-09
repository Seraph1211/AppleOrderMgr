const { DataTypes } = require('sequelize');

/** 定义身份核验持久化批次。 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'IdentityVerificationBatch',
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      userId: { type: DataTypes.INTEGER, allowNull: false, field: 'user_id' },
      source: { type: DataTypes.STRING(10), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false },
      idempotencyKey: { type: DataTypes.UUID, field: 'idempotency_key' },
      requestHash: { type: DataTypes.STRING(64), field: 'request_hash' },
      summary: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      message: { type: DataTypes.STRING(255) },
      expiresAt: { type: DataTypes.DATE, field: 'expires_at' },
    },
    { tableName: 'identity_verification_batches', underscored: true, timestamps: true }
  );
