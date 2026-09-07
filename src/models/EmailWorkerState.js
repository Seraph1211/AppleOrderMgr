const { DataTypes } = require('sequelize');

/**
 * 邮件 Worker 跨进程状态。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} EmailWorkerState 模型
 */
module.exports = sequelize =>
  sequelize.define(
    'EmailWorkerState',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
      mailboxIdentityHash: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'mailbox_identity_hash',
      },
      workerId: { type: DataTypes.STRING(100), allowNull: true, field: 'worker_id' },
      isConnected: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_connected',
      },
      heartbeatAt: { type: DataTypes.DATE, allowNull: true, field: 'heartbeat_at' },
      lastReceivedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_received_at' },
      lastSucceededAt: { type: DataTypes.DATE, allowNull: true, field: 'last_succeeded_at' },
      consecutiveFailures: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'consecutive_failures',
      },
      lastErrorCode: { type: DataTypes.STRING(64), allowNull: true, field: 'last_error_code' },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'updated_at',
      },
    },
    { tableName: 'email_worker_states', timestamps: true, underscored: true }
  );
