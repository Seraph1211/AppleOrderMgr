const { DataTypes } = require('sequelize');
/** 定义压缩块与可选周期辅助元数据；表结构只由正式迁移维护。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorLogBlock',
    {
      businessDate: {
        type: DataTypes.DATEONLY,
        field: 'business_date',
        allowNull: false,
        primaryKey: true,
      },
      id: {
        type: DataTypes.BIGINT,
        field: 'id',
        allowNull: false,
        primaryKey: true,
        autoIncrement: true,
      },
      deviceId: { type: DataTypes.UUID, field: 'device_id', allowNull: false },
      localId: { type: DataTypes.UUID, field: 'local_id', allowNull: false },
      fileKey: { type: DataTypes.BIGINT, field: 'file_key', allowNull: false },
      fileName: { type: DataTypes.STRING(255), field: 'file_name', allowNull: false },
      formatVersion: {
        type: DataTypes.SMALLINT,
        field: 'format_version',
        allowNull: false,
        defaultValue: 1,
      },
      codec: { type: DataTypes.TEXT, field: 'codec', allowNull: false },
      payload: { type: DataTypes.BLOB, field: 'payload', allowNull: false },
      payloadHash: { type: DataTypes.BLOB, field: 'payload_hash', allowNull: false },
      // PostgreSQL 实列是 BIT(8192)；TEXT 仅映射驱动返回的位串，不用于 sync/create。
      signature: { type: DataTypes.TEXT, field: 'signature', allowNull: false },
      entryCount: { type: DataTypes.INTEGER, field: 'entry_count', allowNull: false },
      rawBytes: { type: DataTypes.INTEGER, field: 'raw_bytes', allowNull: false },
      minSortAt: { type: DataTypes.DATE, field: 'min_sort_at', allowNull: false },
      minFileId: { type: DataTypes.UUID, field: 'min_file_id', allowNull: false },
      minByteOffset: { type: DataTypes.BIGINT, field: 'min_byte_offset', allowNull: false },
      maxSortAt: { type: DataTypes.DATE, field: 'max_sort_at', allowNull: false },
      maxFileId: { type: DataTypes.UUID, field: 'max_file_id', allowNull: false },
      maxByteOffset: { type: DataTypes.BIGINT, field: 'max_byte_offset', allowNull: false },
      createdAt: {
        type: DataTypes.DATE,
        field: 'created_at',
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      repeatLimits: { type: DataTypes.JSONB, field: 'repeat_limits', allowNull: true },
    },
    { tableName: 'monitor_log_blocks', timestamps: false, underscored: true }
  );
