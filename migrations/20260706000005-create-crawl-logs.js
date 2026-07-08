'use strict';

/**
 * 创建 crawl_logs 表
 * @description 爬虫执行日志表
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('crawl_logs', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID，自增'
      },
      order_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        comment: '关联的订单ID',
        references: {
          model: 'orders',
          key: 'id'
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      source: {
        type: Sequelize.STRING(50),
        allowNull: false,
        defaultValue: 'auto',
        comment: '数据源（用于审计）：auto/manual/scheduled'
      },
      proxy_ip: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: '使用的代理IP'
      },
      raw_html: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: '原始网页HTML内容（完整响应页面，用于调试和重新解析）'
      },
      success: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '爬取是否成功'
      },
      response_time: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: '响应时间（毫秒）'
      },
      http_status: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: 'HTTP状态码'
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: '错误信息'
      },
      error_stack: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: '错误堆栈'
      },
      crawled_data: {
        type: Sequelize.JSONB,
        allowNull: true,
        comment: '爬取到的数据（JSON格式）'
      },
      data_hash: {
        type: Sequelize.STRING(64),
        allowNull: true,
        comment: '数据哈希值（用于检测内容变化）'
      },
      is_wind_control: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否触发风控（HTTP 541）'
      },
      retry_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '重试次数'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: '记录创建时间'
      }
    }, {
      comment: '爬虫执行日志表'
    });

    // 创建索引
    await queryInterface.addIndex('crawl_logs', ['order_id'], {
      name: 'idx_crawl_logs_order_id'
    });
    await queryInterface.addIndex('crawl_logs', ['source'], {
      name: 'idx_crawl_logs_source'
    });
    await queryInterface.addIndex('crawl_logs', ['success'], {
      name: 'idx_crawl_logs_success'
    });
    await queryInterface.addIndex('crawl_logs', ['proxy_ip'], {
      name: 'idx_crawl_logs_proxy_ip'
    });
    await queryInterface.addIndex('crawl_logs', ['http_status'], {
      name: 'idx_crawl_logs_http_status'
    });
    await queryInterface.addIndex('crawl_logs', ['is_wind_control'], {
      name: 'idx_crawl_logs_is_wind_control'
    });
    await queryInterface.addIndex('crawl_logs', ['created_at'], {
      name: 'idx_crawl_logs_created_at'
    });
    await queryInterface.addIndex('crawl_logs', ['order_id', 'created_at'], {
      name: 'idx_crawl_logs_order_created'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('crawl_logs');
  }
};
