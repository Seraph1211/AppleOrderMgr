'use strict';

/**
 * 增加 Apple 官网自动同步字段和系统日志字段
 * @description 支持订单状态/支付/取货/金额/商品校验同步，以及调度器日志查询
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('orders', 'payment_status', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: '官网支付状态'
    });

    await queryInterface.addColumn('orders', 'pickup_status', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: '官网取货状态'
    });

    await queryInterface.addColumn('orders', 'official_order_amount', {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: true,
      comment: '官网订单金额'
    });

    await queryInterface.addColumn('orders', 'official_order_amount_currency', {
      type: Sequelize.STRING(10),
      allowNull: true,
      comment: '官网订单金额币种'
    });

    await queryInterface.addColumn('orders', 'official_order_amount_parse_error', {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: '官网订单金额解析失败原因'
    });

    await queryInterface.addColumn('orders', 'official_products', {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: '官网商品列表（不含图片）'
    });

    await queryInterface.addColumn('orders', 'validation_status', {
      type: Sequelize.STRING(50),
      allowNull: false,
      defaultValue: 'unchecked',
      comment: '商品校验状态：unchecked/valid/abnormal/unavailable'
    });

    await queryInterface.addColumn('orders', 'validation_issues', {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: '商品校验异常明细'
    });

    await queryInterface.addColumn('orders', 'anomaly_detected_at', {
      type: Sequelize.DATE,
      allowNull: true,
      comment: '异常订单发现时间'
    });

    await queryInterface.addColumn('orders', 'auto_refresh_enabled', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: '是否允许自动刷新'
    });

    await queryInterface.addColumn('orders', 'auto_refresh_stop_reason', {
      type: Sequelize.STRING(100),
      allowNull: true,
      comment: '自动刷新停止原因'
    });

    await queryInterface.addColumn('orders', 'auto_refresh_stopped_at', {
      type: Sequelize.DATE,
      allowNull: true,
      comment: '自动刷新停止时间'
    });

    await queryInterface.changeColumn('crawl_logs', 'order_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      comment: '关联的订单ID；系统级日志可为空',
      references: {
        model: 'orders',
        key: 'id'
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    await queryInterface.addColumn('crawl_logs', 'severity', {
      type: Sequelize.STRING(20),
      allowNull: false,
      defaultValue: 'info',
      comment: '日志严重程度：error/warn/info/debug'
    });

    await queryInterface.addColumn('crawl_logs', 'event_type', {
      type: Sequelize.STRING(50),
      allowNull: false,
      defaultValue: 'crawler',
      comment: '日志类型：crawler/proxy/wind_control/product_validation/amount_parse/scheduler'
    });

    await queryInterface.addColumn('crawl_logs', 'event', {
      type: Sequelize.STRING(255),
      allowNull: true,
      comment: '事件名称或摘要'
    });

    await queryInterface.addColumn('crawl_logs', 'context', {
      type: Sequelize.JSONB,
      allowNull: true,
      comment: '结构化上下文'
    });

    await queryInterface.addColumn('crawl_logs', 'result', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: '处理结果摘要'
    });

    await queryInterface.addIndex('orders', ['payment_status'], {
      name: 'idx_orders_payment_status'
    });
    await queryInterface.addIndex('orders', ['pickup_status'], {
      name: 'idx_orders_pickup_status'
    });
    await queryInterface.addIndex('orders', ['validation_status'], {
      name: 'idx_orders_validation_status'
    });
    await queryInterface.addIndex('orders', ['auto_refresh_enabled'], {
      name: 'idx_orders_auto_refresh_enabled'
    });
    await queryInterface.sequelize.query(`
      CREATE INDEX idx_orders_official_products_gin ON orders USING GIN(official_products);
    `);
    await queryInterface.addIndex('crawl_logs', ['severity'], {
      name: 'idx_crawl_logs_severity'
    });
    await queryInterface.addIndex('crawl_logs', ['event_type'], {
      name: 'idx_crawl_logs_event_type'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('crawl_logs', 'idx_crawl_logs_event_type');
    await queryInterface.removeIndex('crawl_logs', 'idx_crawl_logs_severity');
    await queryInterface.removeIndex('orders', 'idx_orders_official_products_gin');
    await queryInterface.removeIndex('orders', 'idx_orders_auto_refresh_enabled');
    await queryInterface.removeIndex('orders', 'idx_orders_validation_status');
    await queryInterface.removeIndex('orders', 'idx_orders_pickup_status');
    await queryInterface.removeIndex('orders', 'idx_orders_payment_status');

    await queryInterface.removeColumn('crawl_logs', 'result');
    await queryInterface.removeColumn('crawl_logs', 'context');
    await queryInterface.removeColumn('crawl_logs', 'event');
    await queryInterface.removeColumn('crawl_logs', 'event_type');
    await queryInterface.removeColumn('crawl_logs', 'severity');

    // 系统级日志允许 order_id 为 NULL；回滚到旧结构前必须清理，否则 NOT NULL 约束会失败。
    await queryInterface.sequelize.query('DELETE FROM crawl_logs WHERE order_id IS NULL;');

    await queryInterface.changeColumn('crawl_logs', 'order_id', {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: {
        model: 'orders',
        key: 'id'
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    await queryInterface.removeColumn('orders', 'auto_refresh_stopped_at');
    await queryInterface.removeColumn('orders', 'auto_refresh_stop_reason');
    await queryInterface.removeColumn('orders', 'auto_refresh_enabled');
    await queryInterface.removeColumn('orders', 'anomaly_detected_at');
    await queryInterface.removeColumn('orders', 'validation_issues');
    await queryInterface.removeColumn('orders', 'validation_status');
    await queryInterface.removeColumn('orders', 'official_products');
    await queryInterface.removeColumn('orders', 'official_order_amount_parse_error');
    await queryInterface.removeColumn('orders', 'official_order_amount_currency');
    await queryInterface.removeColumn('orders', 'official_order_amount');
    await queryInterface.removeColumn('orders', 'pickup_status');
    await queryInterface.removeColumn('orders', 'payment_status');
  }
};
