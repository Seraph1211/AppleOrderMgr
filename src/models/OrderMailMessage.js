const { DataTypes } = require('sequelize');
const { encrypt, decrypt, encryptJson, decryptJson } = require('../utils/fieldEncryption');

/** 定义独立订单邮件归档，不参与自动建单。 */
module.exports = sequelize =>
  sequelize.define(
    'OrderMailMessage',
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      mailboxIdentityHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'mailbox_identity_hash',
      },
      uidValidity: { type: DataTypes.STRING(100), allowNull: false, field: 'uid_validity' },
      emailUid: { type: DataTypes.BIGINT, allowNull: false, field: 'email_uid' },
      orderNumber: { type: DataTypes.STRING(50), allowNull: false, field: 'order_number' },
      mimeSha256: { type: DataTypes.STRING(64), allowNull: false, field: 'mime_sha256' },
      metadata: {
        type: DataTypes.JSONB,
        allowNull: true,
        get() {
          return decryptJson(this.getDataValue('metadata'));
        },
        set(value) {
          this.setDataValue('metadata', encryptJson(value));
        },
      },
      rawContent: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'raw_content',
        get() {
          return decrypt(this.getDataValue('rawContent'));
        },
        set(value) {
          this.setDataValue('rawContent', encrypt(value));
        },
      },
      emailDate: { type: DataTypes.DATE, allowNull: true, field: 'email_date' },
      receivedAt: { type: DataTypes.DATE, allowNull: true, field: 'received_at' },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
    },
    {
      tableName: 'order_mail_messages',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['mailbox_identity_hash', 'uid_validity', 'email_uid'] },
        { unique: true, fields: ['mailbox_identity_hash', 'mime_sha256'] },
        { fields: ['order_number', 'email_date'] },
      ],
    }
  );
