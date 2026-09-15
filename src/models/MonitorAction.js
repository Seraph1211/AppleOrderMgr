const { DataTypes } = require('sequelize');
/** 定义服务器监控持久化模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorAction',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      instanceId: { type: DataTypes.UUID, allowNull: true, field: 'instance_id' },
      actorId: { type: DataTypes.INTEGER, allowNull: false, field: 'actor_id' },
      action: { type: DataTypes.STRING(30), allowNull: false, field: 'action' },
      note: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '', field: 'note' },
      details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'details' },
    },
    { tableName: 'monitor_actions', underscored: true, timestamps: true }
  );
