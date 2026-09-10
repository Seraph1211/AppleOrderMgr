const { DataTypes } = require('sequelize');
/** 定义 IngestionOperation 持久化模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'IngestionOperation',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      kind: { type: DataTypes.STRING(30), allowNull: false, field: 'kind' },
      scope: { type: DataTypes.STRING(255), allowNull: false, field: 'scope' },
      requestHash: { type: DataTypes.STRING(64), allowNull: true, field: 'request_hash' },
      actorId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_id' },
      deviceId: { type: DataTypes.UUID, allowNull: true, field: 'device_id' },
      status: { type: DataTypes.STRING(30), allowNull: false, field: 'status' },
      data: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'data' },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
    },
    { tableName: 'ingestion_operations', underscored: true, timestamps: true }
  );
