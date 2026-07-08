'use strict';

/**
 * 创建 orders 表
 * @description 订单管理表
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('orders', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID，自增'
      },
      // 订单基础信息
      order_number: {
        type: Sequelize.STRING(20),
        allowNull: false,
        unique: true,
        comment: 'Apple订单号（W开头）'
      },
      apple_id_ref: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: '关联到apple_ids表的外键',
        references: {
          model: 'apple_ids',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      },
      recipient_ref: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: '关联到recipients表的外键',
        references: {
          model: 'recipients',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      },
      // 产品信息（JSONB存储）
      products: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
        comment: '产品列表（JSON数组）'
      },
      // 订单状态
      status: {
        type: Sequelize.STRING(50),
        allowNull: false,
        defaultValue: 'pending',
        comment: '订单状态'
      },
      order_url: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Apple订单查询链接'
      },
      // 支付和物流
      payment_method: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: '付款方式'
      },
      pickup_store: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: '取货门店'
      },
      pickup_code: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: '取货码'
      },
      // 时间信息
      order_date: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: '下单时间（来自邮件）'
      },
      order_placed_date: {
        type: Sequelize.DATEONLY,
        allowNull: true,
        comment: '下单日期（来自官网）'
      },
      official_pickup_date: {
        type: Sequelize.DATEONLY,
        allowNull: true,
        comment: '官网取货日期'
      },
      actual_pickup_date: {
        type: Sequelize.DATEONLY,
        allowNull: true,
        comment: '实际取货日期'
      },
      // 爬虫相关
      last_crawled_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: '最后爬取时间'
      },
      crawl_fail_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '爬取失败次数'
      },
      // 业务字段
      tag: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: '订单标签'
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: '备注'
      },
      // 时间戳
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: '记录创建时间'
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: '记录更新时间'
      }
    }, {
      comment: '订单管理表'
    });

    // 创建索引
    await queryInterface.addIndex('orders', ['order_number'], {
      unique: true,
      name: 'uk_order_number'
    });
    await queryInterface.addIndex('orders', ['apple_id_ref'], {
      name: 'idx_orders_apple_id_ref'
    });
    await queryInterface.addIndex('orders', ['recipient_ref'], {
      name: 'idx_orders_recipient_ref'
    });
    await queryInterface.addIndex('orders', ['status'], {
      name: 'idx_orders_status'
    });
    await queryInterface.addIndex('orders', ['order_date'], {
      name: 'idx_orders_order_date'
    });
    await queryInterface.addIndex('orders', ['official_pickup_date'], {
      name: 'idx_orders_official_pickup_date'
    });
    await queryInterface.addIndex('orders', ['actual_pickup_date'], {
      name: 'idx_orders_actual_pickup_date'
    });
    await queryInterface.addIndex('orders', ['tag'], {
      name: 'idx_orders_tag'
    });
    await queryInterface.addIndex('orders', ['last_crawled_at'], {
      name: 'idx_orders_last_crawled_at'
    });

    // 创建 GIN 索引用于 JSONB 查询
    await queryInterface.sequelize.query(`
      CREATE INDEX idx_orders_products_gin ON orders USING GIN(products);
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('orders');
  }
};
