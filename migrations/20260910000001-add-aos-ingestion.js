'use strict';

module.exports = {
  async up(queryInterface, S) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable(
        'ingestion_settings',
        {
          id: { type: S.INTEGER, allowNull: false, primaryKey: true },
          active_source: { type: S.STRING(10), allowNull: false, defaultValue: 'email' },
          version: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
          effective_at: { type: S.DATE, allowNull: false },
          updated_by: { type: S.INTEGER, allowNull: true },
          created_at: { type: S.DATE, allowNull: false },
          updated_at: { type: S.DATE, allowNull: false },
        },
        { transaction }
      );
      await queryInterface.createTable(
        'aos_devices',
        {
          id: { type: S.UUID, allowNull: false, primaryKey: true },
          name: { type: S.STRING(100), allowNull: false },
          notes: { type: S.STRING(500), allowNull: true },
          enabled: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
          version: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
          credential_version: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
          credential_hash: { type: S.STRING(64), allowNull: false },
          heartbeat_id: { type: S.UUID, allowNull: true },
          heartbeat_at: { type: S.DATE, allowNull: true },
          telemetry: { type: S.JSONB, allowNull: false, defaultValue: {} },
          created_at: { type: S.DATE, allowNull: false },
          updated_at: { type: S.DATE, allowNull: false },
        },
        { transaction }
      );
      await queryInterface.addIndex('aos_devices', ['credential_hash'], {
        unique: true,
        transaction,
      });
      await queryInterface.createTable(
        'aos_records',
        {
          id: { type: S.UUID, allowNull: false, primaryKey: true },
          device_id: {
            type: S.UUID,
            allowNull: false,
            references: { model: 'aos_devices', key: 'id' },
            onDelete: 'RESTRICT',
          },
          event_id: { type: S.UUID, allowNull: false },
          payload_hash: { type: S.STRING(64), allowNull: false },
          payload: { type: S.JSONB, allowNull: false },
          draft: { type: S.JSONB, allowNull: true },
          safe_preview: { type: S.JSONB, allowNull: false, defaultValue: {} },
          file_name: { type: S.STRING(255), allowNull: false },
          line_number: { type: S.INTEGER, allowNull: false },
          order_number: { type: S.STRING(11), allowNull: true },
          order_date: { type: S.DATE, allowNull: true },
          received_at: { type: S.DATE, allowNull: false },
          status: { type: S.STRING(30), allowNull: false, defaultValue: 'received' },
          eligible_at: { type: S.DATE, allowNull: true },
          eligibility: { type: S.STRING(30), allowNull: false, defaultValue: 'out_of_range' },
          order_id: {
            type: S.INTEGER,
            allowNull: true,
            references: { model: 'orders', key: 'id' },
            onDelete: 'RESTRICT',
          },
          version: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
          attempt_count: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
          next_retry_at: { type: S.DATE, allowNull: true },
          lease_until: { type: S.DATE, allowNull: true },
          lease_token: { type: S.UUID, allowNull: true },
          issues: { type: S.JSONB, allowNull: false, defaultValue: [] },
          error_code: { type: S.STRING(100), allowNull: true },
          history: { type: S.JSONB, allowNull: false, defaultValue: [] },
          outcome: { type: S.STRING(30), allowNull: true },
          created_at: { type: S.DATE, allowNull: false },
          updated_at: { type: S.DATE, allowNull: false },
        },
        { transaction }
      );
      await queryInterface.addIndex('aos_records', ['device_id', 'event_id'], {
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('aos_records', ['status', 'next_retry_at'], {
        unique: false,
        transaction,
      });
      await queryInterface.addIndex('aos_records', ['lease_until'], { unique: false, transaction });
      await queryInterface.addIndex('aos_records', ['order_number'], {
        unique: false,
        transaction,
      });
      await queryInterface.createTable(
        'ingestion_operations',
        {
          id: { type: S.UUID, allowNull: false, primaryKey: true },
          kind: { type: S.STRING(30), allowNull: false },
          scope: { type: S.STRING(255), allowNull: false },
          request_hash: { type: S.STRING(64), allowNull: true },
          actor_id: { type: S.INTEGER, allowNull: true },
          device_id: {
            type: S.UUID,
            allowNull: true,
            references: { model: 'aos_devices', key: 'id' },
            onDelete: 'RESTRICT',
          },
          status: { type: S.STRING(30), allowNull: false },
          data: { type: S.JSONB, allowNull: false, defaultValue: {} },
          expires_at: { type: S.DATE, allowNull: true },
          created_at: { type: S.DATE, allowNull: false },
          updated_at: { type: S.DATE, allowNull: false },
        },
        { transaction }
      );
      await queryInterface.addIndex('ingestion_operations', ['scope'], {
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('ingestion_operations', ['kind', 'status'], {
        unique: false,
        transaction,
      });
      await queryInterface.createTable(
        'order_sources',
        {
          id: { type: S.UUID, allowNull: false, primaryKey: true },
          order_id: {
            type: S.INTEGER,
            allowNull: false,
            references: { model: 'orders', key: 'id' },
            onDelete: 'RESTRICT',
          },
          source: { type: S.STRING(10), allowNull: false },
          aos_record_id: {
            type: S.UUID,
            allowNull: true,
            references: { model: 'aos_records', key: 'id' },
            onDelete: 'RESTRICT',
          },
          email_log_id: {
            type: S.INTEGER,
            allowNull: true,
            references: { model: 'email_logs', key: 'id' },
            onDelete: 'RESTRICT',
          },
          result: { type: S.STRING(30), allowNull: false },
          received_at: { type: S.DATE, allowNull: false },
          created_at: { type: S.DATE, allowNull: false },
          updated_at: { type: S.DATE, allowNull: false },
        },
        { transaction }
      );
      await queryInterface.addIndex('order_sources', ['aos_record_id'], {
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('order_sources', ['email_log_id'], {
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('order_sources', ['order_id'], { unique: false, transaction });
      await queryInterface.createTable(
        'pickup_stores',
        {
          code: { type: S.STRING(50), allowNull: false, primaryKey: true },
          name: { type: S.STRING(100), allowNull: false },
          city: { type: S.STRING(100), allowNull: true },
          source_url: { type: S.STRING(2048), allowNull: false },
          verified_at: { type: S.DATE, allowNull: false },
          created_at: { type: S.DATE, allowNull: false },
          updated_at: { type: S.DATE, allowNull: false },
        },
        { transaction }
      );
      await queryInterface.addColumn(
        'orders',
        'ingestion_source',
        { type: S.STRING(10), allowNull: false, defaultValue: 'unknown' },
        { transaction }
      );
      await queryInterface.addColumn(
        'orders',
        'source_recipient_tag',
        { type: S.STRING(500) },
        { transaction }
      );
      await queryInterface.addColumn(
        'orders',
        'source_contact_email',
        { type: S.STRING(255) },
        { transaction }
      );
      await queryInterface.addColumn(
        'orders',
        'source_last_name',
        { type: S.STRING(50) },
        { transaction }
      );
      await queryInterface.addColumn(
        'orders',
        'source_first_name',
        { type: S.STRING(50) },
        { transaction }
      );
      await queryInterface.addColumn(
        'email_logs',
        'ingestion_eligible_at',
        { type: S.DATE },
        { transaction }
      );
      await queryInterface.addColumn(
        'email_logs',
        'ingestion_pause_reason',
        { type: S.STRING(30) },
        { transaction }
      );
      await queryInterface.bulkInsert(
        'ingestion_settings',
        [
          {
            id: 1,
            active_source: 'email',
            version: 1,
            effective_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        { transaction }
      );
      await queryInterface.sequelize.query(
        "UPDATE orders SET ingestion_source = 'email' WHERE id IN (SELECT order_id FROM email_logs WHERE status = 'succeeded' AND order_id IS NOT NULL)",
        { transaction }
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn('email_logs', 'ingestion_pause_reason', { transaction });
      await queryInterface.removeColumn('email_logs', 'ingestion_eligible_at', { transaction });
      await queryInterface.removeColumn('orders', 'source_first_name', { transaction });
      await queryInterface.removeColumn('orders', 'source_last_name', { transaction });
      await queryInterface.removeColumn('orders', 'source_contact_email', { transaction });
      await queryInterface.removeColumn('orders', 'source_recipient_tag', { transaction });
      await queryInterface.removeColumn('orders', 'ingestion_source', { transaction });
      await queryInterface.dropTable('pickup_stores', { transaction });
      await queryInterface.dropTable('order_sources', { transaction });
      await queryInterface.dropTable('ingestion_operations', { transaction });
      await queryInterface.dropTable('aos_records', { transaction });
      await queryInterface.dropTable('aos_devices', { transaction });
      await queryInterface.dropTable('ingestion_settings', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
