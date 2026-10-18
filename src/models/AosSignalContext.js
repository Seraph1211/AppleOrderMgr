const { DataTypes } = require('sequelize');

/** 跨批次的设备、实例、文件及完整任务上下文。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'AosSignalContext',
    {
      id: { type: DataTypes.STRING(200), primaryKey: true, allowNull: false },
      body: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    { tableName: 'aos_signal_contexts', underscored: true, timestamps: true }
  );
