const { DataTypes } = require('sequelize');

/**
 * 定义订单刷新 Worker 的持久化运行状态。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} 订单刷新系统状态模型
 */
module.exports = sequelize => {
  const OrderRefreshSystemState = sequelize.define(
    'OrderRefreshSystemState',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
      isPaused: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_paused',
      },
      pauseReason: { type: DataTypes.TEXT, field: 'pause_reason' },
      pausedAt: { type: DataTypes.DATE, field: 'paused_at' },
      updatedBy: {
        type: DataTypes.INTEGER,
        field: 'updated_by',
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      workerId: { type: DataTypes.STRING(100), field: 'worker_id' },
      heartbeatAt: { type: DataTypes.DATE, field: 'heartbeat_at' },
      nextRequestAt: { type: DataTypes.DATE, field: 'next_request_at' },
      requestedProxyProvider: {
        type: DataTypes.STRING(30),
        field: 'requested_proxy_provider',
      },
      activeProxyProvider: {
        type: DataTypes.STRING(30),
        field: 'active_proxy_provider',
      },
      proxySwitchStatus: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'idle',
        field: 'proxy_switch_status',
      },
      proxySwitchErrorCode: {
        type: DataTypes.STRING(50),
        field: 'proxy_switch_error_code',
      },
      proxySwitchErrorMessage: {
        type: DataTypes.TEXT,
        field: 'proxy_switch_error_message',
      },
      proxySwitchRequestedAt: {
        type: DataTypes.DATE,
        field: 'proxy_switch_requested_at',
      },
      proxySwitchedAt: { type: DataTypes.DATE, field: 'proxy_switched_at' },
    },
    { tableName: 'order_refresh_system_states', underscored: true, timestamps: true }
  );

  OrderRefreshSystemState.associate = models => {
    OrderRefreshSystemState.belongsTo(models.User, {
      foreignKey: 'updatedBy',
      as: 'updatedByUser',
    });
  };

  return OrderRefreshSystemState;
};
