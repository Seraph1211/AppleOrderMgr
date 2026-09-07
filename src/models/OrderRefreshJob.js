const { DataTypes } = require('sequelize');

const JOB_TRIGGERS = ['auto', 'page_open', 'manual_single', 'manual_all'];
const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'skipped'];

/**
 * 定义订单刷新任务模型。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} 订单刷新任务模型
 */
module.exports = sequelize => {
  const OrderRefreshJob = sequelize.define(
    'OrderRefreshJob',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      orderId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'order_id',
        references: { model: 'orders', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      trigger: {
        type: DataTypes.STRING(30),
        allowNull: false,
        validate: { isIn: [JOB_TRIGGERS] },
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        validate: { isIn: [JOB_STATUSES] },
      },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
      scheduledAt: { type: DataTypes.DATE, allowNull: false, field: 'scheduled_at' },
      leaseOwner: { type: DataTypes.STRING(100), field: 'lease_owner' },
      leaseExpiresAt: { type: DataTypes.DATE, field: 'lease_expires_at' },
      attemptCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'attempt_count',
      },
      lastErrorCode: { type: DataTypes.STRING(50), field: 'last_error_code' },
      lastErrorMessage: { type: DataTypes.TEXT, field: 'last_error_message' },
      batchId: {
        type: DataTypes.INTEGER,
        field: 'batch_id',
        references: { model: 'order_refresh_batches', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      requestedBy: {
        type: DataTypes.INTEGER,
        field: 'requested_by',
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      startedAt: { type: DataTypes.DATE, field: 'started_at' },
      finishedAt: { type: DataTypes.DATE, field: 'finished_at' },
    },
    { tableName: 'order_refresh_jobs', underscored: true, timestamps: true }
  );

  OrderRefreshJob.associate = models => {
    OrderRefreshJob.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    OrderRefreshJob.belongsTo(models.OrderRefreshBatch, { foreignKey: 'batchId', as: 'batch' });
    OrderRefreshJob.belongsTo(models.User, { foreignKey: 'requestedBy', as: 'requester' });
  };

  return OrderRefreshJob;
};
