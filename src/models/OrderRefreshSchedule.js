const { DataTypes } = require('sequelize');

const FRESHNESS_STATUSES = ['fresh', 'stale', 'refreshing', 'failed'];

/**
 * 定义订单刷新调度模型。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} 订单刷新调度模型
 */
module.exports = sequelize => {
  const OrderRefreshSchedule = sequelize.define(
    'OrderRefreshSchedule',
    {
      orderId: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        field: 'order_id',
        references: { model: 'orders', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      nextAutoRefreshAt: { type: DataTypes.DATE, field: 'next_auto_refresh_at' },
      lastAttemptAt: { type: DataTypes.DATE, field: 'last_attempt_at' },
      lastSuccessAt: { type: DataTypes.DATE, field: 'last_success_at' },
      lastFailureAt: { type: DataTypes.DATE, field: 'last_failure_at' },
      consecutiveFailures: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'consecutive_failures',
        validate: { min: 0 },
      },
      freshnessStatus: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'stale',
        field: 'freshness_status',
        validate: { isIn: [FRESHNESS_STATUSES] },
      },
      lastErrorCode: { type: DataTypes.STRING(50), field: 'last_error_code' },
      lastErrorMessage: { type: DataTypes.TEXT, field: 'last_error_message' },
    },
    {
      tableName: 'order_refresh_schedules',
      underscored: true,
      timestamps: true,
    }
  );

  OrderRefreshSchedule.associate = models => {
    OrderRefreshSchedule.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };

  return OrderRefreshSchedule;
};
