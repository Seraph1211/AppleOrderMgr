const { DataTypes } = require('sequelize');
const { encryptJson, decryptJson } = require('../utils/fieldEncryption');

/** 定义订单邮件独立发送队列和历史。 */
module.exports = sequelize =>
  sequelize.define(
    'OrderMailDelivery',
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      orderId: { type: DataTypes.INTEGER, allowNull: false, field: 'order_id' },
      messageId: { type: DataTypes.UUID, allowNull: false, field: 'message_id' },
      actorUserId: { type: DataTypes.INTEGER, allowNull: false, field: 'actor_user_id' },
      idempotencyKey: { type: DataTypes.STRING(100), allowNull: false, field: 'idempotency_key' },
      payload: {
        type: DataTypes.JSONB,
        allowNull: false,
        get() {
          return decryptJson(this.getDataValue('payload'));
        },
        set(value) {
          this.setDataValue('payload', encryptJson(value));
        },
      },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      notBefore: { type: DataTypes.DATE, allowNull: false, field: 'not_before' },
      startedAt: { type: DataTypes.DATE, allowNull: true, field: 'started_at' },
      sentAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_at' },
      errorCode: { type: DataTypes.STRING(50), allowNull: true, field: 'error_code' },
    },
    {
      tableName: 'order_mail_deliveries',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['actor_user_id', 'idempotency_key'] },
        { fields: ['status', 'not_before'] },
      ],
    }
  );
