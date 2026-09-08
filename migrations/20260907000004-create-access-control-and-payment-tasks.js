/**
 * 创建逐用户权限、订单付款人审计与付款任务调度表。
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      const timestamps = {
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
      };
      const userReference = {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      };

      await queryInterface.addColumn(
        'users',
        'permissions_version',
        { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        { transaction }
      );

      await queryInterface.createTable(
        'user_permissions',
        {
          id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
          user_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          permission_code: { type: Sequelize.STRING(100), allowNull: false },
          granted_by: userReference,
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.addIndex('user_permissions', ['user_id', 'permission_code'], {
        name: 'uq_user_permissions_user_code',
        unique: true,
        transaction,
      });
      await queryInterface.addIndex('user_permissions', ['permission_code'], {
        name: 'idx_user_permissions_code',
        transaction,
      });

      await queryInterface.createTable(
        'user_permission_events',
        {
          id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
          user_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          actor_user_id: userReference,
          before_permissions: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
          after_permissions: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
          reason: { type: Sequelize.STRING(500), allowNull: true },
          before_version: { type: Sequelize.INTEGER, allowNull: false },
          after_version: { type: Sequelize.INTEGER, allowNull: false },
          idempotency_key: { type: Sequelize.STRING(100), allowNull: true },
          source: { type: Sequelize.STRING(50), allowNull: false, defaultValue: 'api' },
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.addIndex('user_permission_events', ['user_id', 'created_at'], {
        name: 'idx_user_permission_events_user_created',
        transaction,
      });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uq_user_permission_events_idempotency
         ON user_permission_events (actor_user_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL`,
        { transaction }
      );

      await queryInterface.addColumn(
        'orders',
        'payer_version',
        { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        { transaction }
      );
      await queryInterface.createTable(
        'payment_tasks',
        {
          id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
          order_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            unique: true,
            references: { model: 'orders', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          assignee_user_id: userReference,
          processing_status: {
            type: Sequelize.STRING(20),
            allowNull: false,
            defaultValue: 'pending',
          },
          processing_notes: { type: Sequelize.TEXT, allowNull: true },
          deadline_at: { type: Sequelize.DATE, allowNull: true },
          deadline_source: { type: Sequelize.STRING(30), allowNull: true },
          eligibility_verified_at: { type: Sequelize.DATE, allowNull: true },
          eligibility_valid_until: { type: Sequelize.DATE, allowNull: true },
          eligibility_verified_by: userReference,
          payment_link_source: { type: Sequelize.STRING(30), allowNull: true },
          assigned_at: { type: Sequelize.DATE, allowNull: true },
          completed_at: { type: Sequelize.DATE, allowNull: true },
          version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.addConstraint('payment_tasks', {
        fields: ['processing_status'],
        type: 'check',
        name: 'chk_payment_tasks_status',
        where: { processing_status: ['pending', 'processing', 'completed', 'exception'] },
        transaction,
      });
      await queryInterface.addConstraint('payment_tasks', {
        fields: ['deadline_source'],
        type: 'check',
        name: 'chk_payment_tasks_deadline_source',
        where: { deadline_source: ['official', 'manual_verified'] },
        transaction,
      });
      await queryInterface.addConstraint('payment_tasks', {
        fields: ['payment_link_source'],
        type: 'check',
        name: 'chk_payment_tasks_link_source',
        where: { payment_link_source: ['order_url'] },
        transaction,
      });
      await queryInterface.addIndex(
        'payment_tasks',
        ['assignee_user_id', 'processing_status', 'deadline_at'],
        { name: 'idx_payment_tasks_assignee_status_deadline', transaction }
      );
      await queryInterface.addIndex('payment_tasks', ['processing_status', 'deadline_at'], {
        name: 'idx_payment_tasks_status_deadline',
        transaction,
      });
      await queryInterface.sequelize.query(
        `CREATE INDEX idx_payment_tasks_unassigned_pending_deadline
         ON payment_tasks (deadline_at, id)
         WHERE assignee_user_id IS NULL AND processing_status = 'pending'`,
        { transaction }
      );

      await queryInterface.createTable(
        'payment_task_events',
        {
          id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
          payment_task_id: {
            type: Sequelize.BIGINT,
            allowNull: false,
            references: { model: 'payment_tasks', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          event_type: { type: Sequelize.STRING(50), allowNull: false },
          actor_user_id: userReference,
          from_user_id: userReference,
          to_user_id: userReference,
          before_status: { type: Sequelize.STRING(20), allowNull: true },
          after_status: { type: Sequelize.STRING(20), allowNull: true },
          details: { type: Sequelize.JSONB, allowNull: true },
          idempotency_key: { type: Sequelize.STRING(100), allowNull: true },
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.addIndex('payment_task_events', ['payment_task_id', 'created_at'], {
        name: 'idx_payment_task_events_task_created',
        transaction,
      });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uq_payment_task_events_idempotency
         ON payment_task_events (actor_user_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL`,
        { transaction }
      );

      await queryInterface.createTable(
        'order_payer_events',
        {
          id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
          order_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: 'orders', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          previous_payer_name: { type: Sequelize.TEXT, allowNull: true },
          new_payer_name: { type: Sequelize.TEXT, allowNull: true },
          actor_user_id: userReference,
          reason: { type: Sequelize.STRING(500), allowNull: true },
          before_version: { type: Sequelize.INTEGER, allowNull: false },
          after_version: { type: Sequelize.INTEGER, allowNull: false },
          idempotency_key: { type: Sequelize.STRING(100), allowNull: false },
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.addIndex('order_payer_events', ['order_id', 'created_at'], {
        name: 'idx_order_payer_events_order_created',
        transaction,
      });
      await queryInterface.addIndex('order_payer_events', ['actor_user_id', 'idempotency_key'], {
        name: 'uq_order_payer_events_idempotency',
        unique: true,
        transaction,
      });

      await queryInterface.createTable(
        'payment_dispatch_settings',
        {
          id: { type: Sequelize.SMALLINT, primaryKey: true, defaultValue: 1 },
          enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
          mode: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'manual' },
          scope_started_at: { type: Sequelize.DATE, allowNull: true },
          freshness_seconds: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 90 },
          eligibility_seconds: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 300 },
          pending_reminder_seconds: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 120,
          },
          warning_seconds: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 600 },
          urgent_seconds: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 300 },
          last_scan_at: { type: Sequelize.DATE, allowNull: true },
          last_error_code: { type: Sequelize.STRING(50), allowNull: true },
          version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          updated_by: userReference,
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.addConstraint('payment_dispatch_settings', {
        fields: ['mode'],
        type: 'check',
        name: 'chk_payment_dispatch_settings_mode',
        where: { mode: ['manual', 'auto'] },
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE payment_dispatch_settings
         ADD CONSTRAINT chk_payment_dispatch_settings_singleton CHECK (id = 1),
         ADD CONSTRAINT chk_payment_dispatch_settings_thresholds CHECK (
           freshness_seconds > 0 AND eligibility_seconds > 0
           AND pending_reminder_seconds > 0 AND warning_seconds > urgent_seconds
           AND urgent_seconds > 0
         )`,
        { transaction }
      );

      await queryInterface.createTable(
        'payment_staff_settings',
        {
          id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
          user_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            unique: true,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          auto_assign_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
          max_active_tasks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          last_assigned_at: { type: Sequelize.DATE, allowNull: true },
          version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          updated_by: userReference,
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.addConstraint('payment_staff_settings', {
        fields: ['max_active_tasks'],
        type: 'check',
        name: 'chk_payment_staff_settings_capacity',
        where: { max_active_tasks: { [Sequelize.Op.between]: [0, 1000] } },
        transaction,
      });

      await queryInterface.createTable(
        'payment_dispatch_events',
        {
          id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
          event_type: { type: Sequelize.STRING(50), allowNull: false },
          actor_user_id: userReference,
          order_id: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: 'orders', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          payment_task_id: {
            type: Sequelize.BIGINT,
            allowNull: true,
            references: { model: 'payment_tasks', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          error_code: { type: Sequelize.STRING(50), allowNull: true },
          details: { type: Sequelize.JSONB, allowNull: true },
          idempotency_key: { type: Sequelize.STRING(100), allowNull: true },
          ...timestamps,
        },
        { transaction }
      );
      await queryInterface.addIndex('payment_dispatch_events', ['created_at'], {
        name: 'idx_payment_dispatch_events_created',
        transaction,
      });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uq_payment_dispatch_events_idempotency
         ON payment_dispatch_events (actor_user_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `INSERT INTO payment_dispatch_settings
           (id, enabled, mode, freshness_seconds, eligibility_seconds,
            pending_reminder_seconds, warning_seconds, urgent_seconds, version,
            created_at, updated_at)
         VALUES (1, FALSE, 'manual', 90, 300, 120, 600, 300, 0,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `WITH role_permissions(role, permission_code) AS (
           VALUES
             ('operator', 'dashboard.read'), ('operator', 'stats.read'),
             ('operator', 'orders.read'), ('operator', 'orders.edit'),
             ('operator', 'orders.export'), ('operator', 'orders.refresh'),
             ('operator', 'orders.payer.edit'), ('operator', 'apple_ids.read'),
             ('operator', 'apple_ids.create'), ('operator', 'apple_ids.edit'),
             ('operator', 'apple_ids.import'), ('operator', 'apple_ids.template.read'),
             ('operator', 'recipients.read'), ('operator', 'recipients.create'),
             ('operator', 'recipients.edit'), ('operator', 'recipients.export'),
             ('operator', 'recipients.import'), ('operator', 'recipients.template.read'),
             ('operator', 'recipients.generate_contact'),
             ('operator', 'recipients.generate_address'),
             ('operator', 'recipients.bind_apple_ids'), ('operator', 'channels.read'),
             ('operator', 'channels.rename'), ('readOnly', 'dashboard.read'),
             ('readOnly', 'stats.read'), ('readOnly', 'orders.read'),
             ('readOnly', 'apple_ids.read'), ('readOnly', 'apple_ids.template.read'),
             ('readOnly', 'recipients.read'), ('readOnly', 'recipients.template.read'),
             ('readOnly', 'channels.read')
         )
         INSERT INTO user_permissions
           (user_id, permission_code, granted_by, created_at, updated_at)
         SELECT users.id, role_permissions.permission_code, NULL,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           FROM users
           JOIN role_permissions ON role_permissions.role = users.role
          WHERE users.role <> 'admin'
         ON CONFLICT (user_id, permission_code) DO NOTHING`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `INSERT INTO user_permission_events
           (user_id, actor_user_id, before_permissions, after_permissions, reason,
            before_version, after_version, source, created_at, updated_at)
         SELECT users.id, NULL, '[]'::jsonb,
                COALESCE(
                  (SELECT jsonb_agg(permission_code ORDER BY permission_code)
                     FROM user_permissions WHERE user_id = users.id),
                  '[]'::jsonb
                ),
                '存量角色权限迁移', 0, 1, 'legacy_role_migration',
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           FROM users
          WHERE users.role <> 'admin'`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `UPDATE users
            SET permissions_version = 1,
                updated_at = CURRENT_TIMESTAMP
          WHERE role <> 'admin'`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.dropTable('payment_dispatch_events', { transaction });
      await queryInterface.dropTable('payment_staff_settings', { transaction });
      await queryInterface.dropTable('payment_dispatch_settings', { transaction });
      await queryInterface.dropTable('order_payer_events', { transaction });
      await queryInterface.dropTable('payment_task_events', { transaction });
      await queryInterface.dropTable('payment_tasks', { transaction });
      await queryInterface.removeColumn('orders', 'payer_version', { transaction });
      await queryInterface.dropTable('user_permission_events', { transaction });
      await queryInterface.dropTable('user_permissions', { transaction });
      await queryInterface.removeColumn('users', 'permissions_version', { transaction });
    });
  },
};
