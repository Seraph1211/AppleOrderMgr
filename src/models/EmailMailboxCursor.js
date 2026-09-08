const { DataTypes } = require('sequelize');

/**
 * 定义按邮箱与 UIDVALIDITY 隔离的可靠接收进度。
 * @param {import('sequelize').Sequelize} sequelize - 数据库实例
 * @returns {import('sequelize').Model} 游标模型
 */
module.exports = sequelize =>
  sequelize.define(
    'EmailMailboxCursor',
    {
      mailboxIdentityHash: {
        type: DataTypes.STRING(64),
        primaryKey: true,
        allowNull: false,
        field: 'mailbox_identity_hash',
      },
      uidValidity: {
        type: DataTypes.STRING(100),
        primaryKey: true,
        allowNull: false,
        field: 'uid_validity',
      },
      lastUid: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'last_uid',
        validate: { min: 1, max: 4294967295 },
      },
      bootstrapSince: { type: DataTypes.DATE, allowNull: false, field: 'bootstrap_since' },
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
    { tableName: 'email_mailbox_cursors', timestamps: true, underscored: true }
  );
