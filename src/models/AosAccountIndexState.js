const { DataTypes } = require('sequelize');
/** 独立日志账号索引模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'AosAccountIndexState',
    {
      id: { type: DataTypes.STRING(64), primaryKey: true, allowNull: false },
      deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
      localId: { type: DataTypes.UUID, allowNull: false, field: 'local_id' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
      body: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    { tableName: 'aos_account_index_states', underscored: true, timestamps: true }
  );
