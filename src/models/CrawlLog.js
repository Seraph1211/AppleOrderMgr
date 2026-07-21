const { DataTypes } = require('sequelize');

/**
 * CrawlLog 模型 - 爬虫执行日志
 * @module models/CrawlLog
 * @description 记录订单爬取历史，用于监控爬虫性能和错误追踪
 */

/**
 * 定义 CrawlLog 模型
 * @param {import('sequelize').Sequelize} sequelize - Sequelize实例
 * @returns {import('sequelize').Model} CrawlLog模型
 */
module.exports = (sequelize) => {
  const CrawlLog = sequelize.define('CrawlLog', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      comment: '主键ID，自增'
    },
    orderId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'order_id',
      comment: '关联的订单ID',
      references: {
        model: 'orders',
        key: 'id'
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    source: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'auto',
      comment: '数据源（用于审计）：auto/manual/scheduled',
      validate: {
        isIn: {
          args: [['auto', 'manual', 'scheduled', 'system']],
          msg: '数据源必须是 auto、manual、scheduled 或 system'
        }
      }
    },
    severity: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'info',
      comment: '日志严重程度：error/warn/info/debug',
      validate: {
        isIn: {
          args: [['error', 'warn', 'info', 'debug']],
          msg: '严重程度必须是 error、warn、info 或 debug'
        }
      }
    },
    eventType: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'crawler',
      field: 'event_type',
      comment: '日志类型：crawler/proxy/wind_control/product_validation/amount_parse/scheduler'
    },
    event: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: '事件名称或摘要'
    },
    proxyIp: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: 'proxy_ip',
      comment: '使用的代理IP或IP:端口'
    },
    rawHtml: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'raw_html',
      comment: '原始网页HTML内容（完整响应页面，用于调试和重新解析）'
    },
    success: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '爬取是否成功'
    },
    responseTime: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'response_time',
      comment: '响应时间（毫秒）',
      validate: {
        min: {
          args: [0],
          msg: '响应时间不能为负数'
        }
      }
    },
    httpStatus: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'http_status',
      comment: 'HTTP状态码',
      validate: {
        min: {
          args: [100],
          msg: 'HTTP状态码必须在100-599之间'
        },
        max: {
          args: [599],
          msg: 'HTTP状态码必须在100-599之间'
        }
      }
    },
    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'error_message',
      comment: '错误信息'
    },
    errorStack: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'error_stack',
      comment: '错误堆栈'
    },
    context: {
      type: DataTypes.JSONB,
      allowNull: true,
      comment: '结构化上下文'
    },
    result: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: '处理结果摘要'
    },
    crawledData: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: 'crawled_data',
      comment: '爬取到的数据（JSON格式）'
    },
    dataHash: {
      type: DataTypes.STRING(64),
      allowNull: true,
      field: 'data_hash',
      comment: '数据哈希值（用于检测内容变化）'
    },
    isWindControl: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'is_wind_control',
      comment: '是否触发风控（HTTP 541）'
    },
    retryCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'retry_count',
      comment: '重试次数'
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'created_at',
      comment: '记录创建时间'
    }
  }, {
    tableName: 'crawl_logs',
    timestamps: false,
    underscored: true,
    indexes: [
      {
        fields: ['order_id'],
        name: 'idx_crawl_logs_order_id'
      },
      {
        fields: ['source'],
        name: 'idx_crawl_logs_source'
      },
      {
        fields: ['severity'],
        name: 'idx_crawl_logs_severity'
      },
      {
        fields: ['event_type'],
        name: 'idx_crawl_logs_event_type'
      },
      {
        fields: ['success'],
        name: 'idx_crawl_logs_success'
      },
      {
        fields: ['proxy_ip'],
        name: 'idx_crawl_logs_proxy_ip'
      },
      {
        fields: ['http_status'],
        name: 'idx_crawl_logs_http_status'
      },
      {
        fields: ['is_wind_control'],
        name: 'idx_crawl_logs_is_wind_control'
      },
      {
        fields: ['created_at'],
        name: 'idx_crawl_logs_created_at'
      },
      {
        fields: ['order_id', 'created_at'],
        name: 'idx_crawl_logs_order_created'
      }
    ],
    comment: '爬虫执行日志表'
  });

  /**
   * 定义模型关联关系
   * @param {Object} models - 所有模型的集合
   */
  CrawlLog.associate = (models) => {
    // 爬虫日志关联到订单
    CrawlLog.belongsTo(models.Order, {
      foreignKey: 'order_id',
      as: 'order'
    });
  };

  return CrawlLog;
};
