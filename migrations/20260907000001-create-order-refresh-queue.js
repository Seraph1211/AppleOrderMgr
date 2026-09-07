/**
 * 创建订单刷新持久化队列、调度、批次和 Worker 状态。
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

      await queryInterface.createTable(
        'order_refresh_batches',
        {
          id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
          status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
          requested_by: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          total_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          pending_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          running_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          succeeded_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          failed_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          skipped_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          started_at: { type: Sequelize.DATE, allowNull: true },
          finished_at: { type: Sequelize.DATE, allowNull: true },
          ...timestamps,
        },
        { transaction }
      );

      await queryInterface.createTable(
        'order_refresh_schedules',
        {
          order_id: {
            type: Sequelize.INTEGER,
            primaryKey: true,
            references: { model: 'orders', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          next_auto_refresh_at: { type: Sequelize.DATE, allowNull: true },
          last_attempt_at: { type: Sequelize.DATE, allowNull: true },
          last_success_at: { type: Sequelize.DATE, allowNull: true },
          last_failure_at: { type: Sequelize.DATE, allowNull: true },
          consecutive_failures: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          freshness_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'stale' },
          last_error_code: { type: Sequelize.STRING(50), allowNull: true },
          last_error_message: { type: Sequelize.TEXT, allowNull: true },
          ...timestamps,
        },
        { transaction }
      );

      await queryInterface.createTable(
        'order_refresh_jobs',
        {
          id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
          order_id: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: 'orders', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          trigger: { type: Sequelize.STRING(30), allowNull: false },
          status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
          priority: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 100 },
          scheduled_at: { type: Sequelize.DATE, allowNull: false },
          lease_owner: { type: Sequelize.STRING(100), allowNull: true },
          lease_expires_at: { type: Sequelize.DATE, allowNull: true },
          attempt_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          last_error_code: { type: Sequelize.STRING(50), allowNull: true },
          last_error_message: { type: Sequelize.TEXT, allowNull: true },
          batch_id: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: 'order_refresh_batches', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          requested_by: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          started_at: { type: Sequelize.DATE, allowNull: true },
          finished_at: { type: Sequelize.DATE, allowNull: true },
          ...timestamps,
        },
        { transaction }
      );

      await queryInterface.createTable(
        'order_refresh_system_states',
        {
          id: { type: Sequelize.INTEGER, primaryKey: true, defaultValue: 1 },
          is_paused: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
          pause_reason: { type: Sequelize.TEXT, allowNull: true },
          paused_at: { type: Sequelize.DATE, allowNull: true },
          updated_by: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          worker_id: { type: Sequelize.STRING(100), allowNull: true },
          heartbeat_at: { type: Sequelize.DATE, allowNull: true },
          next_request_at: { type: Sequelize.DATE, allowNull: true },
          ...timestamps,
        },
        { transaction }
      );

      await queryInterface.addConstraint('order_refresh_batches', {
        fields: ['status'],
        type: 'check',
        name: 'chk_order_refresh_batches_status',
        where: { status: ['pending', 'running', 'completed'] },
        transaction,
      });
      await queryInterface.addConstraint('order_refresh_schedules', {
        fields: ['freshness_status'],
        type: 'check',
        name: 'chk_order_refresh_schedules_freshness',
        where: { freshness_status: ['fresh', 'stale', 'refreshing', 'failed'] },
        transaction,
      });
      await queryInterface.addConstraint('order_refresh_schedules', {
        fields: ['consecutive_failures'],
        type: 'check',
        name: 'chk_order_refresh_schedules_failures',
        where: { consecutive_failures: { [Sequelize.Op.gte]: 0 } },
        transaction,
      });
      await queryInterface.addConstraint('order_refresh_jobs', {
        fields: ['trigger'],
        type: 'check',
        name: 'chk_order_refresh_jobs_trigger',
        where: { trigger: ['auto', 'page_open', 'manual_single', 'manual_all'] },
        transaction,
      });
      await queryInterface.addConstraint('order_refresh_jobs', {
        fields: ['status'],
        type: 'check',
        name: 'chk_order_refresh_jobs_status',
        where: { status: ['pending', 'running', 'succeeded', 'failed', 'skipped'] },
        transaction,
      });

      await queryInterface.addIndex('order_refresh_schedules', ['next_auto_refresh_at'], {
        name: 'idx_order_refresh_schedules_due',
        transaction,
      });
      await queryInterface.addIndex('order_refresh_schedules', ['freshness_status'], {
        name: 'idx_order_refresh_schedules_freshness',
        transaction,
      });
      await queryInterface.addIndex('order_refresh_schedules', ['last_success_at'], {
        name: 'idx_order_refresh_schedules_last_success',
        transaction,
      });
      await queryInterface.addIndex('order_refresh_jobs', ['status', 'scheduled_at', 'priority'], {
        name: 'idx_order_refresh_jobs_claim',
        transaction,
      });
      await queryInterface.addIndex('order_refresh_jobs', ['batch_id', 'status'], {
        name: 'idx_order_refresh_jobs_batch_status',
        transaction,
      });

      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uq_order_refresh_jobs_active_order
         ON order_refresh_jobs (order_id)
         WHERE status IN ('pending', 'running')`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX uq_order_refresh_batches_active
         ON order_refresh_batches ((1))
         WHERE status IN ('pending', 'running')`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `INSERT INTO order_refresh_system_states
           (id, is_paused, created_at, updated_at)
         VALUES (1, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `INSERT INTO order_refresh_schedules
           (order_id, next_auto_refresh_at, last_success_at, freshness_status, created_at, updated_at)
         SELECT id,
                CASE
                  WHEN order_url IS NOT NULL
                   AND auto_refresh_enabled IS TRUE
                   AND COALESCE(payment_status, 'unknown') NOT IN ('paid', 'refunded')
                   AND status NOT IN ('completed', 'delivered', 'cancelled', 'pickup_cancelled')
                   AND COALESCE(validation_status, 'unchecked') <> 'abnormal'
                  THEN CURRENT_TIMESTAMP
                  ELSE NULL
                END,
                last_crawled_at,
                CASE WHEN last_crawled_at IS NULL THEN 'stale' ELSE 'fresh' END,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP
           FROM orders
         ON CONFLICT (order_id) DO NOTHING`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.dropTable('order_refresh_system_states', { transaction });
      await queryInterface.dropTable('order_refresh_jobs', { transaction });
      await queryInterface.dropTable('order_refresh_schedules', { transaction });
      await queryInterface.dropTable('order_refresh_batches', { transaction });
    });
  },
};
