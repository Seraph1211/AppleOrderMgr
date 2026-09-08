const { DataTypes } = require('sequelize');
const { encryptJson, decryptJson } = require('../utils/fieldEncryption');

/**
 * 定义付款调度追加事件模型。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} PaymentDispatchEvent 模型
 */
module.exports = sequelize => {
  const PaymentDispatchEvent = sequelize.define(
    'PaymentDispatchEvent',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      eventType: { type: DataTypes.STRING(50), allowNull: false, field: 'event_type' },
      actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
      orderId: { type: DataTypes.INTEGER, allowNull: true, field: 'order_id' },
      paymentTaskId: { type: DataTypes.BIGINT, allowNull: true, field: 'payment_task_id' },
      errorCode: { type: DataTypes.STRING(50), allowNull: true, field: 'error_code' },
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
    { tableName: 'payment_dispatch_events', underscored: true, timestamps: true }
  );

  PaymentDispatchEvent.associate = models => {
    PaymentDispatchEvent.belongsTo(models.User, { foreignKey: 'actorUserId', as: 'actor' });
    PaymentDispatchEvent.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    PaymentDispatchEvent.belongsTo(models.PaymentTask, {
      foreignKey: 'paymentTaskId',
      as: 'task',
    });
  };

  return PaymentDispatchEvent;
};
