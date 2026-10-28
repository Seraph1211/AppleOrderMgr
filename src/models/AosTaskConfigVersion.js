const { DataTypes } = require('sequelize');
/** 定义脱敏任务配置模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'AosTaskConfigVersion',
    {
      id: { type: DataTypes.UUID, allowNull: false, field: 'id', primaryKey: true },
      instanceId: { type: DataTypes.UUID, allowNull: false, field: 'instance_id' },
      number: { type: DataTypes.INTEGER, allowNull: false, field: 'number' },
      effectiveAt: { type: DataTypes.DATE, allowNull: false, field: 'effective_at' },
      effectiveTo: { type: DataTypes.DATE, allowNull: true, field: 'effective_to' },
      actorId: { type: DataTypes.INTEGER, allowNull: false, field: 'actor_id' },
      source: { type: DataTypes.STRING(16), allowNull: false, field: 'source' },
      restoredFromId: { type: DataTypes.UUID, allowNull: true, field: 'restored_from_id' },
      contentHash: { type: DataTypes.STRING(64), allowNull: false, field: 'content_hash' },
      rows: { type: DataTypes.JSONB, allowNull: false, field: 'rows' },
      aggregates: { type: DataTypes.JSONB, allowNull: false, field: 'aggregates' },
      taskCount: { type: DataTypes.INTEGER, allowNull: false, field: 'task_count' },
      cityCount: { type: DataTypes.INTEGER, allowNull: false, field: 'city_count' },
      specCount: { type: DataTypes.INTEGER, allowNull: false, field: 'spec_count' },
      blankLineCount: { type: DataTypes.INTEGER, allowNull: false, field: 'blank_line_count' },
    },
    { tableName: 'aos_task_config_versions', underscored: true, timestamps: true }
  );
