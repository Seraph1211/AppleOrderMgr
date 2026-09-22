/**
 * 下线官网爬虫的扩展阶段：建立归档快照和独立历史付款限制。
 * 本迁移不移动旧队列表，可在旧 API 仍服务新订单时先执行。
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query('CREATE SCHEMA IF NOT EXISTS archive', {
          transaction,
        });
        await queryInterface.addColumn(
          'orders',
          'payment_assignment_hold_reason',
          { type: Sequelize.STRING(50), allowNull: true },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'payment_assignment_hold_evidence',
          { type: Sequelize.JSONB, allowNull: true },
          { transaction }
        );
        await queryInterface.addConstraint('orders', {
          fields: ['payment_assignment_hold_reason'],
          type: 'check',
          name: 'orders_payment_assignment_hold_reason_valid',
          where: {
            payment_assignment_hold_reason: { [Sequelize.Op.in]: ['legacy_payment_restriction'] },
          },
          transaction,
        });
        await queryInterface.addIndex('orders', ['payment_assignment_hold_reason'], {
          name: 'idx_orders_payment_assignment_hold_reason',
          transaction,
        });
        await queryInterface.sequelize.query(
          `CREATE TABLE archive.order_official_retirement_snapshots (
             order_id INTEGER PRIMARY KEY,
             official_data JSONB NOT NULL,
             archived_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
           )`,
          { transaction }
        );
        await queryInterface.sequelize.query(
          `INSERT INTO archive.order_official_retirement_snapshots (order_id, official_data)
           SELECT id, jsonb_strip_nulls(jsonb_build_object(
             'status', status,
             'paymentStatus', payment_status,
             'pickupStatus', pickup_status,
             'lastCrawledAt', last_crawled_at,
             'crawlFailCount', crawl_fail_count,
             'officialRawStatus', official_raw_status,
             'officialStatusDescription', official_status_description,
             'officialStatusObservedAt', official_status_observed_at,
             'officialFulfillmentMessage', official_fulfillment_message,
             'officialPaymentExpiresAt', official_payment_expires_at,
             'officialPaymentMethod', official_payment_method,
             'officialStatusNeedsReview', official_status_needs_review,
             'officialAllItemsTerminal', official_all_items_terminal,
             'officialFieldDiagnostics', official_field_diagnostics,
             'validationStatus', validation_status,
             'validationIssues', validation_issues,
             'anomalyDetectedAt', anomaly_detected_at,
             'autoRefreshEnabled', auto_refresh_enabled,
             'autoRefreshStopReason', auto_refresh_stop_reason,
             'autoRefreshStoppedAt', auto_refresh_stopped_at
           ))
             FROM orders`,
          { transaction }
        );
        await queryInterface.sequelize.query(
          `REVOKE INSERT, UPDATE, DELETE, TRUNCATE
             ON archive.order_official_retirement_snapshots
           FROM CURRENT_USER`,
          { transaction }
        );
        await queryInterface.sequelize.query(
          `UPDATE orders
              SET payment_assignment_hold_reason = 'legacy_payment_restriction',
                  payment_assignment_hold_evidence = jsonb_build_object(
                    'migration', '20260922000001-prepare-official-order-crawler-retirement',
                    'classification', CASE
                      WHEN payment_status IN ('paid', 'refunded') THEN 'legacy_payment_status'
                      WHEN status IN ('payment_received', 'processing', 'ready_for_pickup',
                                      'picked_up', 'shipped', 'delivered', 'cancelled',
                                      'pickup_cancelled') THEN 'legacy_order_terminal_status'
                      ELSE 'legacy_official_terminal'
                    END,
                    'archiveReference', 'archive.order_official_retirement_snapshots:' || id,
                    'archivedAt', CURRENT_TIMESTAMP
                  )
            WHERE email_payment_status <> 'paid'
              AND payment_assignment_hold_reason IS NULL
              AND (
                payment_status IN ('paid', 'refunded')
                OR status IN ('payment_received', 'processing', 'ready_for_pickup', 'picked_up',
                              'shipped', 'delivered', 'cancelled', 'pickup_cancelled')
                OR (official_all_items_terminal IS TRUE AND status <> 'payment_expired')
              )`,
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('官网订单爬虫下线扩展迁移失败', { cause: error });
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.removeColumn('orders', 'payment_assignment_hold_evidence', {
          transaction,
        });
        await queryInterface.removeColumn('orders', 'payment_assignment_hold_reason', {
          transaction,
        });
        await queryInterface.sequelize.query(
          'DROP TABLE archive.order_official_retirement_snapshots',
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('官网订单爬虫下线扩展迁移回滚失败', { cause: error });
    }
  },
};
