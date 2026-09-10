const { DataTypes } = require('sequelize');
/** 定义 IngestionSetting 持久化模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'IngestionSetting',
    {
      id: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: 'id' },
      activeSource: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'email',
        field: 'active_source',
      },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'version' },
      effectiveAt: { type: DataTypes.DATE, allowNull: false, field: 'effective_at' },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'ingestion_settings', underscored: true, timestamps: true }
  );
