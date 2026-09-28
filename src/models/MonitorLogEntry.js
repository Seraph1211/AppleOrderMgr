const { DataTypes } = require('sequelize');
/** 定义完整日志片段；长行可无损分段。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorLogEntry',
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
      localId: { type: DataTypes.UUID, allowNull: false, field: 'local_id' },
      fileId: { type: DataTypes.UUID, allowNull: false, field: 'file_id' },
      fileName: { type: DataTypes.STRING(255), allowNull: false, field: 'file_name' },
      businessDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'business_date' },
      loggedAt: { type: DataTypes.DATE, field: 'logged_at' },
      sortAt: { type: DataTypes.DATE, allowNull: false, field: 'sort_at' },
      accountNumber: { type: DataTypes.STRING(64), field: 'account_number' },
      lineNumber: { type: DataTypes.BIGINT, allowNull: false, field: 'line_number' },
      partIndex: { type: DataTypes.INTEGER, allowNull: false, field: 'part_index' },
      byteOffset: { type: DataTypes.BIGINT, allowNull: false, field: 'byte_offset' },
      message: { type: DataTypes.TEXT, allowNull: false },
      rawBase64: { type: DataTypes.TEXT, field: 'raw_base64' },
      parseState: { type: DataTypes.STRING(30), allowNull: false, field: 'parse_state' },
      payloadHash: { type: DataTypes.STRING(64), allowNull: false, field: 'payload_hash' },
    },
    { tableName: 'monitor_log_entries', underscored: true, timestamps: true }
  );
