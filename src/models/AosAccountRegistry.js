const { DataTypes } = require('sequelize');
/** 独立日志账号索引模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'AosAccountRegistry',
    {
      id: { type: DataTypes.STRING(64), primaryKey: true, allowNull: false },
      deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
      localId: { type: DataTypes.UUID, allowNull: false, field: 'local_id' },
      accountNumber: { type: DataTypes.STRING(64), allowNull: false, field: 'account_number' },
      firstSeenAt: { type: DataTypes.DATE, allowNull: false, field: 'first_seen_at' },
    },
    { tableName: 'aos_account_registries', underscored: true, timestamps: true }
  );
