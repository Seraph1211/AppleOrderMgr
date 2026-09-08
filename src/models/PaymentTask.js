const { DataTypes } = require('sequelize');
const { encrypt, decrypt } = require('../utils/fieldEncryption');

const PAYMENT_TASK_STATUSES = ['pending', 'processing', 'completed', 'exception'];
const DEADLINE_SOURCES = ['official', 'manual_verified'];

/**
 * 定义付款任务模型。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} PaymentTask 模型
 */
module.exports = sequelize => {
  const PaymentTask = sequelize.define(
    'PaymentTask',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      orderId: { type: DataTypes.INTEGER, allowNull: false, unique: true, field: 'order_id' },
      assigneeUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'assignee_user_id' },
      processingStatus: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        field: 'processing_status',
        validate: { isIn: [PAYMENT_TASK_STATUSES] },
      },
      processingNotes: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'processing_notes',
        set(value) {
          this.setDataValue('processingNotes', encrypt(value));
        },
        get() {
          return decrypt(this.getDataValue('processingNotes'));
        },
      },
      deadlineAt: { type: DataTypes.DATE, allowNull: true, field: 'deadline_at' },
      deadlineSource: {
        type: DataTypes.STRING(30),
        allowNull: true,
        field: 'deadline_source',
        validate: { isIn: [DEADLINE_SOURCES] },
      },
      eligibilityVerifiedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'eligibility_verified_at',
      },
      eligibilityValidUntil: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'eligibility_valid_until',
      },
      eligibilityVerifiedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'eligibility_verified_by',
      },
      paymentLinkSource: {
        type: DataTypes.STRING(30),
        allowNull: true,
        field: 'payment_link_source',
        validate: { isIn: [['order_url']] },
      },
      assignedAt: { type: DataTypes.DATE, allowNull: true, field: 'assigned_at' },
      completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'payment_tasks', underscored: true, timestamps: true }
  );

  PaymentTask.associate = models => {
    PaymentTask.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    PaymentTask.belongsTo(models.User, { foreignKey: 'assigneeUserId', as: 'assignee' });
    PaymentTask.belongsTo(models.User, {
      foreignKey: 'eligibilityVerifiedBy',
      as: 'eligibilityVerifier',
    });
    PaymentTask.hasMany(models.PaymentTaskEvent, { foreignKey: 'paymentTaskId', as: 'events' });
  };

  return PaymentTask;
};

module.exports.PAYMENT_TASK_STATUSES = PAYMENT_TASK_STATUSES;
module.exports.DEADLINE_SOURCES = DEADLINE_SOURCES;
