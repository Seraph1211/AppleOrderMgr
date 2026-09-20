const { DataTypes } = require('sequelize');

/** 定义订单生命周期邮件的持久化解析任务。 */
module.exports = sequelize => {
  const OrderMailProcessingJob = sequelize.define(
    'OrderMailProcessingJob',
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      messageId: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        field: 'message_id',
      },
      status: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'pending',
        validate: {
          isIn: [
            [
              'pending',
              'processing',
              'parsed',
              'applied',
              'applied_pending_payment',
              'waiting_order',
              'needs_review',
              'ignored',
              'failed',
            ],
          ],
        },
      },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      notBefore: { type: DataTypes.DATE, allowNull: false, field: 'not_before' },
      leaseExpiresAt: { type: DataTypes.DATE, allowNull: true, field: 'lease_expires_at' },
      lastErrorCode: { type: DataTypes.STRING(50), allowNull: true, field: 'last_error_code' },
      completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
    },
    {
      tableName: 'order_mail_processing_jobs',
      underscored: true,
      timestamps: true,
      indexes: [{ fields: ['status', 'not_before'] }],
    }
  );

  OrderMailProcessingJob.associate = models => {
    OrderMailProcessingJob.belongsTo(models.OrderMailMessage, {
      foreignKey: 'messageId',
      as: 'message',
    });
  };

  return OrderMailProcessingJob;
};
