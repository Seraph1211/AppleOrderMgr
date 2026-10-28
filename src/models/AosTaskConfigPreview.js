const { DataTypes } = require('sequelize');
/** 定义脱敏任务配置模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'AosTaskConfigPreview',
    {
      id: { type: DataTypes.UUID, allowNull: false, field: 'id', primaryKey: true },
      instanceId: { type: DataTypes.UUID, allowNull: false, field: 'instance_id' },
      actorId: { type: DataTypes.INTEGER, allowNull: false, field: 'actor_id' },
      expectedRevision: { type: DataTypes.INTEGER, allowNull: false, field: 'expected_revision' },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      payload: { type: DataTypes.JSONB, allowNull: false, field: 'payload' },
    },
    { tableName: 'aos_task_config_previews', underscored: true, timestamps: true }
  );
