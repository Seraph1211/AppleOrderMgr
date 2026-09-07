/* eslint-disable camelcase */
const { DataTypes, Op } = require('sequelize');
const { encrypt, decrypt, encryptJson, decryptJson } = require('../utils/fieldEncryption');
const { EMAIL_PROCESSING_STATUSES } = require('../constants/business');

/**
 * EmailLog 模型 - 邮件处理日志
 * @module models/EmailLog
 * @description 记录邮件处理历史，用于去重和错误追踪
 */

/**
 * 定义 EmailLog 模型
 * @param {import('sequelize').Sequelize} sequelize - Sequelize实例
 * @returns {import('sequelize').Model} EmailLog模型
 */
module.exports = sequelize => {
  const EmailLog = sequelize.define(
    'EmailLog',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID，自增',
      },
      emailUid: {
        type: DataTypes.STRING(100),
        allowNull: false,
        field: 'email_uid',
        comment: 'IMAP UID；只在邮箱身份与 UIDVALIDITY 内唯一',
        validate: {
          notEmpty: {
            msg: '邮件UID不能为空',
          },
        },
      },
      mailboxIdentityHash: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'mailbox_identity_hash',
        comment: '邮箱身份不可逆 SHA-256',
      },
      uidValidity: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'uid_validity',
        comment: 'IMAP UIDVALIDITY',
      },
      messageId: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'message_id',
        comment: 'RFC Message-ID',
      },
      mimeSha256: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'mime_sha256',
        comment: '原始 MIME SHA-256',
      },
      authenticationResults: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'authentication_results',
        comment: 'Authentication-Results 原始头，仅记录不作为阻断条件',
      },
      emailSubject: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'email_subject',
        comment: '邮件主题',
      },
      emailFrom: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'email_from',
        comment: '发件人（可能包含显示名称，如 "NULL预订助手" <email@domain.com>）',
      },
      emailDate: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'email_date',
        comment: '邮件发送时间',
      },
      source: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'imap',
        comment: '数据源（用于审计）：imap/manual/api',
        validate: {
          isIn: {
            args: [['imap', 'manual', 'api']],
            msg: '数据源必须是 imap、manual 或 api',
          },
        },
      },
      rawContent: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'raw_content',
        comment: '原始邮件内容（Base64 后使用 AES-256-GCM 加密）',
        set(value) {
          this.setDataValue('rawContent', encrypt(value));
        },
        get() {
          return decrypt(this.getDataValue('rawContent'));
        },
      },
      processed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否已处理',
      },
      processedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'processed_at',
        comment: '处理时间',
      },
      success: {
        type: DataTypes.BOOLEAN,
        allowNull: true,
        comment: '处理是否成功',
      },
      errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'error_message',
        comment: '错误信息',
      },
      parsedData: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'parsed_data',
        comment: '解析后的数据（JSONB 密文包装）',
        set(value) {
          this.setDataValue('parsedData', encryptJson(value));
        },
        get() {
          return decryptJson(this.getDataValue('parsedData'));
        },
      },
      orderNumber: {
        type: DataTypes.STRING(20),
        allowNull: true,
        field: 'order_number',
        comment: '关联的订单号（冗余字段，便于查询）',
        validate: {
          is: {
            args: /^W\d{10}$/,
            msg: '订单号必须是W开头后跟10位数字',
          },
        },
      },
      retryCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'retry_count',
        comment: '重试次数',
      },
      status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'received',
        validate: {
          isIn: {
            args: [EMAIL_PROCESSING_STATUSES],
            msg: '邮件处理状态无效',
          },
        },
      },
      errorCode: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'error_code',
      },
      nextRetryAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'next_retry_at',
      },
      lastAttemptAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_attempt_at',
      },
      imapAckStatus: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'pending',
        field: 'imap_ack_status',
        validate: {
          isIn: {
            args: [['pending', 'not_required', 'retry_wait', 'succeeded']],
            msg: 'IMAP 确认状态无效',
          },
        },
      },
      imapAckRetryCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'imap_ack_retry_count',
      },
      imapAckNextRetryAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'imap_ack_next_retry_at',
      },
      imapAckErrorCode: {
        type: DataTypes.STRING(64),
        allowNull: true,
        field: 'imap_ack_error_code',
      },
      resolvedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'resolved_at',
      },
      resolutionType: {
        type: DataTypes.STRING(32),
        allowNull: true,
        field: 'resolution_type',
      },
      resolutionReason: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'resolution_reason',
      },
      resolvedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'resolved_by',
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      manualDraft: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'manual_draft',
        set(value) {
          this.setDataValue('manualDraft', encryptJson(value));
        },
        get() {
          return decryptJson(this.getDataValue('manualDraft'));
        },
      },
      finalData: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'final_data',
        set(value) {
          this.setDataValue('finalData', encryptJson(value));
        },
        get() {
          return decryptJson(this.getDataValue('finalData'));
        },
      },
      attemptHistory: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        field: 'attempt_history',
        set(value) {
          this.setDataValue('attemptHistory', encryptJson(value || []));
        },
        get() {
          return decryptJson(this.getDataValue('attemptHistory')) || [];
        },
      },
      auditHistory: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        field: 'audit_history',
        set(value) {
          this.setDataValue('auditHistory', encryptJson(value || []));
        },
        get() {
          return decryptJson(this.getDataValue('auditHistory')) || [];
        },
      },
      orderId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'order_id',
        references: { model: 'orders', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      receivedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'received_at',
      },
      retentionExpiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'retention_expires_at',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
        comment: '记录创建时间',
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'updated_at',
        comment: '记录更新时间',
      },
    },
    {
      tableName: 'email_logs',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          unique: true,
          fields: ['mailbox_identity_hash', 'uid_validity', 'email_uid'],
          name: 'uk_email_logs_mailbox_uid',
          where: {
            mailbox_identity_hash: { [Op.ne]: null },
            uid_validity: { [Op.ne]: null },
          },
        },
        {
          fields: ['processed'],
          name: 'idx_email_logs_processed',
        },
        {
          fields: ['success'],
          name: 'idx_email_logs_success',
        },
        {
          fields: ['source'],
          name: 'idx_email_logs_source',
        },
        {
          fields: ['order_number'],
          name: 'idx_email_logs_order_number',
        },
        {
          fields: ['email_date'],
          name: 'idx_email_logs_email_date',
        },
        {
          fields: ['processed_at'],
          name: 'idx_email_logs_processed_at',
        },
        {
          fields: ['email_from'],
          name: 'idx_email_logs_email_from',
        },
        { fields: ['message_id'], name: 'idx_email_logs_message_id' },
        { fields: ['mime_sha256'], name: 'idx_email_logs_mime_sha256' },
        { fields: ['status', 'next_retry_at'], name: 'idx_email_logs_retry_queue' },
        {
          fields: ['imap_ack_status', 'imap_ack_next_retry_at'],
          name: 'idx_email_logs_ack_queue',
        },
        { fields: ['retention_expires_at'], name: 'idx_email_logs_retention' },
        { fields: ['order_id'], name: 'idx_email_logs_order_id' },
      ],
      comment: '邮件处理日志表',
    }
  );

  /**
   * 定义模型关联关系
   * @param {Object} models - 所有模型的集合
   */
  EmailLog.associate = models => {
    EmailLog.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    EmailLog.belongsTo(models.User, { foreignKey: 'resolvedBy', as: 'resolver' });
  };

  return EmailLog;
};
