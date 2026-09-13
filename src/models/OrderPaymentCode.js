const { DataTypes } = require('sequelize');
const { encryptJson, decryptJson } = require('../utils/fieldEncryption');
/** 定义加密付款码来源记录。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'OrderPaymentCode',
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      deviceId: { type: DataTypes.UUID, allowNull: false, field: 'device_id' },
      eventId: { type: DataTypes.UUID, allowNull: false, field: 'event_id' },
      orderNumber: { type: DataTypes.STRING(11), allowNull: false, field: 'order_number' },
      orderId: { type: DataTypes.INTEGER, allowNull: true, field: 'order_id' },
      sourceTime: { type: DataTypes.DATE, allowNull: false, field: 'source_time' },
      imageHash: { type: DataTypes.STRING(64), allowNull: false, field: 'image_hash' },
      payloadHash: { type: DataTypes.STRING(64), allowNull: false, field: 'payload_hash' },
      payload: {
        type: DataTypes.JSONB,
        allowNull: false,
        set(value) {
          this.setDataValue('payload', encryptJson(value));
        },
        get() {
          return decryptJson(this.getDataValue('payload'));
        },
      },
    },
    { tableName: 'order_payment_codes', underscored: true, timestamps: true }
  );
