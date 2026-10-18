const { DataTypes } = require('sequelize');

/** 日志事务内的脱敏信号队列；消费后删除。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'AosSignalInbox',
    {
      id: { type: DataTypes.STRING(200), primaryKey: true, allowNull: false },
      body: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    { tableName: 'aos_signal_inbox', underscored: true, timestamps: true }
  );
