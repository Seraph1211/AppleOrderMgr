const { DataTypes } = require('sequelize');
const { encryptJson, decryptJson } = require('../utils/fieldEncryption');

/**
 * 定义付款任务追加事件模型。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} PaymentTaskEvent 模型
 */
module.exports = sequelize => {
  const PaymentTaskEvent = sequelize.define(
    'PaymentTaskEvent',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      paymentTaskId: { type: DataTypes.BIGINT, allowNull: false, field: 'payment_task_id' },
      eventType: { type: DataTypes.STRING(50), allowNull: false, field: 'event_type' },
      actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
      fromUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'from_user_id' },
      toUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'to_user_id' },
      beforeStatus: { type: DataTypes.STRING(20), allowNull: true, field: 'before_status' },
      afterStatus: { type: DataTypes.STRING(20), allowNull: true, field: 'after_status' },
      details: {
        type: DataTypes.JSONB,
        allowNull: true,
        set(value) {
          this.setDataValue('details', encryptJson(value));
        },
        get() {
          return decryptJson(this.getDataValue('details'));
        },
      },
      idempotencyKey: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'idempotency_key',
      },
    },
    { tableName: 'payment_task_events', underscored: true, timestamps: true }
  );

  PaymentTaskEvent.associate = models => {
    PaymentTaskEvent.belongsTo(models.PaymentTask, {
      foreignKey: 'paymentTaskId',
      as: 'task',
    });
    PaymentTaskEvent.belongsTo(models.User, { foreignKey: 'actorUserId', as: 'actor' });
  };

  return PaymentTaskEvent;
};
