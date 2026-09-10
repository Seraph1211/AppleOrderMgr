const { DataTypes } = require('sequelize');
/** 定义 AosDevice 持久化模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'AosDevice',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      name: { type: DataTypes.STRING(100), allowNull: false, field: 'name' },
      notes: { type: DataTypes.STRING(500), allowNull: true, field: 'notes' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'enabled' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version' },
      credentialVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        field: 'credential_version',
      },
      credentialHash: { type: DataTypes.STRING(64), allowNull: false, field: 'credential_hash' },
      credentialCiphertext: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'credential_ciphertext',
      },
      heartbeatId: { type: DataTypes.UUID, allowNull: true, field: 'heartbeat_id' },
      heartbeatAt: { type: DataTypes.DATE, allowNull: true, field: 'heartbeat_at' },
      telemetry: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'telemetry' },
    },
    { tableName: 'aos_devices', underscored: true, timestamps: true }
  );
