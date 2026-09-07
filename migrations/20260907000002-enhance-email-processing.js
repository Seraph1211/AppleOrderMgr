'use strict';

const EMAIL_STATUSES = [
  'received',
  'ignored',
  'parsing',
  'retry_wait',
  'manual_review',
  'processing',
  'succeeded',
  'superseded',
];

const ACK_STATUSES = ['pending', 'not_required', 'retry_wait', 'succeeded'];

/**
 * 将 email_logs 演进为邮件接收、重试、人工处理和审计的唯一事实来源。
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query('DROP INDEX IF EXISTS "uk_email_uid"', { transaction });
      await queryInterface.sequelize.query(
        'ALTER TABLE "email_logs" DROP CONSTRAINT IF EXISTS "email_logs_email_uid_key"',
        { transaction }
      );
      await queryInterface.changeColumn(
        'email_logs',
        'email_uid',
        { type: Sequelize.STRING(100), allowNull: false },
        { transaction }
      );

      const columns = {
        mailbox_identity_hash: { type: Sequelize.STRING(64), allowNull: true },
        uid_validity: { type: Sequelize.STRING(100), allowNull: true },
        message_id: { type: Sequelize.TEXT, allowNull: true },
        mime_sha256: { type: Sequelize.STRING(64), allowNull: true },
        authentication_results: { type: Sequelize.TEXT, allowNull: true },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'received',
        },
        error_code: { type: Sequelize.STRING(64), allowNull: true },
        next_retry_at: { type: Sequelize.DATE, allowNull: true },
        last_attempt_at: { type: Sequelize.DATE, allowNull: true },
        imap_ack_status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'pending',
        },
        imap_ack_retry_count: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        imap_ack_next_retry_at: { type: Sequelize.DATE, allowNull: true },
        imap_ack_error_code: { type: Sequelize.STRING(64), allowNull: true },
        resolved_at: { type: Sequelize.DATE, allowNull: true },
        resolution_type: { type: Sequelize.STRING(32), allowNull: true },
        resolution_reason: { type: Sequelize.TEXT, allowNull: true },
        resolved_by: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        manual_draft: { type: Sequelize.JSONB, allowNull: true },
        final_data: { type: Sequelize.JSONB, allowNull: true },
        attempt_history: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: [],
        },
        audit_history: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: [],
        },
        order_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'orders', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        received_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        retention_expires_at: { type: Sequelize.DATE, allowNull: true },
      };

      for (const [name, definition] of Object.entries(columns)) {
        await queryInterface.addColumn('email_logs', name, definition, { transaction });
      }

      await queryInterface.sequelize.query(
        `UPDATE "email_logs"
         SET "status" = CASE
           WHEN "success" IS TRUE THEN 'succeeded'
           WHEN "success" IS FALSE THEN 'manual_review'
           ELSE 'received'
         END,
         "imap_ack_status" = 'not_required',
         "received_at" = COALESCE("created_at", CURRENT_TIMESTAMP),
         "retention_expires_at" = COALESCE("created_at", CURRENT_TIMESTAMP) + INTERVAL '180 days'`,
        { transaction }
      );

      await queryInterface.addConstraint('email_logs', {
        fields: ['status'],
        type: 'check',
        name: 'ck_email_logs_status',
        where: { status: EMAIL_STATUSES },
        transaction,
      });
      await queryInterface.addConstraint('email_logs', {
        fields: ['imap_ack_status'],
        type: 'check',
        name: 'ck_email_logs_imap_ack_status',
        where: { imap_ack_status: ACK_STATUSES },
        transaction,
      });
      await queryInterface.addConstraint('email_logs', {
        fields: ['retry_count'],
        type: 'check',
        name: 'ck_email_logs_retry_count_nonnegative',
        where: { retry_count: { [Sequelize.Op.gte]: 0 } },
        transaction,
      });

      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "uk_email_logs_mailbox_uid"
         ON "email_logs" ("mailbox_identity_hash", "uid_validity", "email_uid")
         WHERE "mailbox_identity_hash" IS NOT NULL AND "uid_validity" IS NOT NULL`,
        { transaction }
      );
      await queryInterface.addIndex('email_logs', ['message_id'], {
        name: 'idx_email_logs_message_id',
        transaction,
      });
      await queryInterface.addIndex('email_logs', ['mime_sha256'], {
        name: 'idx_email_logs_mime_sha256',
        transaction,
      });
      await queryInterface.addIndex('email_logs', ['status', 'next_retry_at'], {
        name: 'idx_email_logs_retry_queue',
        transaction,
      });
      await queryInterface.addIndex('email_logs', ['imap_ack_status', 'imap_ack_next_retry_at'], {
        name: 'idx_email_logs_ack_queue',
        transaction,
      });
      await queryInterface.addIndex('email_logs', ['retention_expires_at'], {
        name: 'idx_email_logs_retention',
        transaction,
      });
      await queryInterface.addIndex('email_logs', ['order_id'], {
        name: 'idx_email_logs_order_id',
        transaction,
      });

      await queryInterface.createTable(
        'email_worker_states',
        {
          id: { type: Sequelize.INTEGER, primaryKey: true, defaultValue: 1 },
          mailbox_identity_hash: { type: Sequelize.STRING(64), allowNull: true },
          worker_id: { type: Sequelize.STRING(100), allowNull: true },
          is_connected: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
          heartbeat_at: { type: Sequelize.DATE, allowNull: true },
          last_received_at: { type: Sequelize.DATE, allowNull: true },
          last_succeeded_at: { type: Sequelize.DATE, allowNull: true },
          consecutive_failures: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          last_error_code: { type: Sequelize.STRING(64), allowNull: true },
          created_at: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
          updated_at: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
        },
        { transaction }
      );
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.dropTable('email_worker_states', { transaction });
      await queryInterface.sequelize.query('DROP INDEX IF EXISTS "uk_email_logs_mailbox_uid"', {
        transaction,
      });
      for (const indexName of [
        'idx_email_logs_message_id',
        'idx_email_logs_mime_sha256',
        'idx_email_logs_retry_queue',
        'idx_email_logs_ack_queue',
        'idx_email_logs_retention',
        'idx_email_logs_order_id',
      ]) {
        await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${indexName}"`, {
          transaction,
        });
      }
      for (const constraintName of [
        'ck_email_logs_status',
        'ck_email_logs_imap_ack_status',
        'ck_email_logs_retry_count_nonnegative',
      ]) {
        await queryInterface.sequelize.query(
          `ALTER TABLE "email_logs" DROP CONSTRAINT IF EXISTS "${constraintName}"`,
          { transaction }
        );
      }

      const columns = [
        'retention_expires_at',
        'received_at',
        'version',
        'order_id',
        'audit_history',
        'attempt_history',
        'final_data',
        'manual_draft',
        'resolved_by',
        'resolution_reason',
        'resolution_type',
        'resolved_at',
        'imap_ack_error_code',
        'imap_ack_next_retry_at',
        'imap_ack_retry_count',
        'imap_ack_status',
        'last_attempt_at',
        'next_retry_at',
        'error_code',
        'status',
        'authentication_results',
        'mime_sha256',
        'message_id',
        'uid_validity',
        'mailbox_identity_hash',
      ];
      for (const column of columns) {
        await queryInterface.removeColumn('email_logs', column, { transaction });
      }
      await queryInterface.addIndex('email_logs', ['email_uid'], {
        unique: true,
        name: 'uk_email_uid',
        transaction,
      });
      await queryInterface.changeColumn(
        'email_logs',
        'email_uid',
        { type: Sequelize.STRING(100), allowNull: false, unique: true },
        { transaction }
      );
    });
  },
};
