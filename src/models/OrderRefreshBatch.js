const { DataTypes } = require('sequelize');

/**
 * 定义订单刷新批次模型。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} 订单刷新批次模型
 */
module.exports = sequelize => {
  const OrderRefreshBatch = sequelize.define(
    'OrderRefreshBatch',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        validate: { isIn: [['pending', 'running', 'completed']] },
      },
      requestedBy: {
        type: DataTypes.INTEGER,
        field: 'requested_by',
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      totalCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'total_count',
      },
      pendingCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'pending_count',
      },
      runningCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'running_count',
      },
      succeededCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'succeeded_count',
      },
      failedCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'failed_count',
      },
      skippedCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'skipped_count',
      },
      startedAt: { type: DataTypes.DATE, field: 'started_at' },
      finishedAt: { type: DataTypes.DATE, field: 'finished_at' },
    },
    { tableName: 'order_refresh_batches', underscored: true, timestamps: true }
  );

  OrderRefreshBatch.associate = models => {
    OrderRefreshBatch.belongsTo(models.User, { foreignKey: 'requestedBy', as: 'requester' });
    OrderRefreshBatch.hasMany(models.OrderRefreshJob, { foreignKey: 'batchId', as: 'jobs' });
  };

  return OrderRefreshBatch;
};
