const { DataTypes } = require('sequelize');
/** 定义 OrderSource 持久化模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'OrderSource',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      orderId: { type: DataTypes.INTEGER, allowNull: false, field: 'order_id' },
      source: { type: DataTypes.STRING(10), allowNull: false, field: 'source' },
      aosRecordId: { type: DataTypes.UUID, allowNull: true, field: 'aos_record_id' },
      emailLogId: { type: DataTypes.INTEGER, allowNull: true, field: 'email_log_id' },
      result: { type: DataTypes.STRING(30), allowNull: false, field: 'result' },
      receivedAt: { type: DataTypes.DATE, allowNull: false, field: 'received_at' },
    },
    { tableName: 'order_sources', underscored: true, timestamps: true }
  );
