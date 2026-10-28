const { DataTypes } = require('sequelize');
/** 定义脱敏任务配置模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'AosTaskConfig',
    {
      instanceId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'instance_id',
        primaryKey: true,
      },
      lastActorId: { type: DataTypes.INTEGER, allowNull: true, field: 'last_actor_id' },
      revision: { type: DataTypes.INTEGER, allowNull: false, field: 'revision' },
      currentVersionId: { type: DataTypes.UUID, allowNull: true, field: 'current_version_id' },
      lastConfirmedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_confirmed_at' },
      invalidatedAt: { type: DataTypes.DATE, allowNull: true, field: 'invalidated_at' },
    },
    { tableName: 'aos_task_configs', underscored: true, timestamps: true }
  );
