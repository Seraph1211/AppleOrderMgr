const { DataTypes } = require('sequelize');
const { encrypt, decrypt } = require('../utils/fieldEncryption');

/**
 * 定义订单付款人关联审计模型。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} OrderPayerEvent 模型
 */
module.exports = sequelize => {
  const OrderPayerEvent = sequelize.define(
    'OrderPayerEvent',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      orderId: { type: DataTypes.INTEGER, allowNull: false, field: 'order_id' },
      previousPayerName: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'previous_payer_name',
        set(value) {
          this.setDataValue('previousPayerName', encrypt(value));
        },
        get() {
          return decrypt(this.getDataValue('previousPayerName'));
        },
      },
      newPayerName: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'new_payer_name',
        set(value) {
          this.setDataValue('newPayerName', encrypt(value));
        },
        get() {
          return decrypt(this.getDataValue('newPayerName'));
        },
      },
      actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
      reason: { type: DataTypes.STRING(500), allowNull: true },
      beforeVersion: { type: DataTypes.INTEGER, allowNull: false, field: 'before_version' },
      afterVersion: { type: DataTypes.INTEGER, allowNull: false, field: 'after_version' },
      idempotencyKey: {
        type: DataTypes.STRING(100),
        allowNull: false,
        field: 'idempotency_key',
      },
    },
    { tableName: 'order_payer_events', underscored: true, timestamps: true }
  );

  OrderPayerEvent.associate = models => {
    OrderPayerEvent.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    OrderPayerEvent.belongsTo(models.User, { foreignKey: 'actorUserId', as: 'actor' });
  };

  return OrderPayerEvent;
};
