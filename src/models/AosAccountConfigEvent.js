const { DataTypes } = require('sequelize');
/** 独立日志账号索引模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'AosAccountConfigEvent',
    {
      id: { type: DataTypes.STRING(200), primaryKey: true, allowNull: false },
      deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
      localId: { type: DataTypes.UUID, allowNull: false, field: 'local_id' },
      accountNumber: { type: DataTypes.STRING(64), allowNull: false, field: 'account_number' },
      fileId: { type: DataTypes.UUID, allowNull: false, field: 'file_id' },
      byteOffset: { type: DataTypes.BIGINT, allowNull: false, field: 'byte_offset' },
      lineIndex: { type: DataTypes.INTEGER, allowNull: false, field: 'line_index' },
      loggedAt: { type: DataTypes.DATE, allowNull: false, field: 'logged_at' },
      kind: { type: DataTypes.STRING(16), allowNull: false },
      body: { type: DataTypes.JSONB, allowNull: false },
      payloadHash: { type: DataTypes.STRING(64), allowNull: false, field: 'payload_hash' },
    },
    { tableName: 'aos_account_config_events', underscored: true, timestamps: true }
  );
