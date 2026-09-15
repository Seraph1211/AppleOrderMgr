const { DataTypes } = require('sequelize');
/** 定义服务器监控持久化模型。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'MonitorAlert',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'id' },
      instanceId: { type: DataTypes.UUID, allowNull: false, field: 'instance_id' },
      ruleId: { type: DataTypes.UUID, allowNull: false, field: 'rule_id' },
      ruleVersion: { type: DataTypes.INTEGER, allowNull: false, field: 'rule_version' },
      ruleName: { type: DataTypes.STRING(100), allowNull: false, field: 'rule_name' },
      severity: { type: DataTypes.STRING(20), allowNull: false, field: 'severity' },
      status: { type: DataTypes.STRING(20), allowNull: false, field: 'status' },
      hitCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'hit_count' },
      quietChecks: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'quiet_checks',
      },
      firstSeenAt: { type: DataTypes.DATE, allowNull: false, field: 'first_seen_at' },
      lastSeenAt: { type: DataTypes.DATE, allowNull: false, field: 'last_seen_at' },
      recoveredAt: { type: DataTypes.DATE, allowNull: true, field: 'recovered_at' },
      samples: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'samples' },
    },
    { tableName: 'monitor_alerts', underscored: true, timestamps: true }
  );
