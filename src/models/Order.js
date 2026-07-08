const { DataTypes } = require('sequelize');

/**
 * Order 模型 - 订单管理
 * @module models/Order
 * @description 管理Apple订单信息，包括订单号、产品列表、状态、物流等
 */

/**
 * 定义 Order 模型
 * @param {import('sequelize').Sequelize} sequelize - Sequelize实例
 * @returns {import('sequelize').Model} Order模型
 */
module.exports = (sequelize) => {
  const Order = sequelize.define('Order', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      comment: '主键ID，自增'
    },
    // 订单基础信息
    orderNumber: {
      type: DataTypes.STRING(20),
      allowNull: false,
      unique: true,
      field: 'order_number',
      comment: 'Apple订单号（W开头）',
      validate: {
        is: {
          args: /^W\d{9}$/,
          msg: '订单号必须是W开头后跟9位数字'
        }
      }
    },
    // Apple ID 相关
    appleIdRef: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'apple_id_ref',
      comment: '关联到apple_ids表的外键',
      references: {
        model: 'apple_ids',
        key: 'id'
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    },
    appleId: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'apple_id',
      comment: 'Apple ID（邮件解析）'
    },
    applePassword: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'apple_password',
      comment: 'Apple ID 密码（从 apple_ids 表匹配填充）'
    },
    // 收件人相关（快照 - 自动匹配填充）
    recipientRef: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'recipient_ref',
      comment: '关联到recipients表的外键',
      references: {
        model: 'recipients',
        key: 'id'
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    },
    recipientName: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'recipient_name',
      comment: '收件人姓名（邮件解析）'
    },
    recipientIdCard: {
      type: DataTypes.STRING(18),
      allowNull: true,
      field: 'recipient_id_card',
      comment: '收件人完整身份证号（从 recipients 表匹配填充）'
    },
    recipientEmail: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'recipient_email',
      comment: '收件人邮箱（从 recipients 表匹配填充）'
    },
    recipientPhone: {
      type: DataTypes.STRING(20),
      allowNull: true,
      field: 'recipient_phone',
      comment: '收件人手机号（从 recipients 表匹配填充）'
    },
    recipientAddress: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'recipient_address',
      comment: '收件人完整地址（从 recipients 表匹配填充）'
    },
    // 产品信息（JSONB存储）
    products: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: '产品列表（JSON数组）',
      validate: {
        isValidProductArray(value) {
          if (!Array.isArray(value)) {
            throw new Error('products必须是数组');
          }
          if (value.length === 0) {
            throw new Error('products不能为空数组');
          }
          value.forEach((product, index) => {
            if (!product.model || !product.name || !product.quantity) {
              throw new Error(`products[${index}]缺少必要字段：model、name、quantity`);
            }
          });
        }
      }
    },
    // 订单状态
    status: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'pending',
      comment: '订单状态',
      validate: {
        isIn: {
          args: [['pending', 'processing', 'shipped', 'ready_for_pickup', 'completed', 'cancelled']],
          msg: '订单状态必须是有效值'
        }
      }
    },
    orderUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'order_url',
      comment: 'Apple订单查询链接',
      validate: {
        isUrl: {
          msg: '订单链接必须是有效的URL'
        }
      }
    },
    // 支付信息
    paymentMethod: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: 'payment_method',
      comment: '付款方式'
    },
    payerName: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'payer_name',
      comment: '付款人姓名'
    },
    paymentScreenshot: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'payment_screenshot',
      comment: '付款截图URL或路径'
    },
    // 取货信息
    pickupStore: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'pickup_store',
      comment: '取货门店'
    },
    pickupStoreCode: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: 'pickup_store_code',
      comment: '取货门店代码（如 R638）'
    },
    pickupCode: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: 'pickup_code',
      comment: '取货码'
    },
    pickupTimeSlot: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: 'pickup_time_slot',
      comment: '取货时间段（如 25-18:30-18:45）'
    },
    // 时间信息
    orderDate: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'order_date',
      comment: '下单时间（来自邮件）'
    },
    actualPickupDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'actual_pickup_date',
      comment: '实际取货日期'
    },
    // 爬虫相关
    lastCrawledAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'last_crawled_at',
      comment: '最后爬取时间'
    },
    crawlFailCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'crawl_fail_count',
      comment: '爬取失败次数'
    },
    // 业务字段
    tag: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: '订单标签'
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '备注'
    },
    // 时间戳
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'created_at',
      comment: '记录创建时间'
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'updated_at',
      comment: '记录更新时间'
    }
  }, {
    tableName: 'orders',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['order_number'],
        name: 'uk_order_number'
      },
      {
        fields: ['apple_id_ref'],
        name: 'idx_orders_apple_id_ref'
      },
      {
        fields: ['apple_id'],
        name: 'idx_orders_apple_id'
      },
      {
        fields: ['recipient_ref'],
        name: 'idx_orders_recipient_ref'
      },
      {
        fields: ['recipient_name'],
        name: 'idx_orders_recipient_name'
      },
      {
        fields: ['recipient_id_card'],
        name: 'idx_orders_recipient_id_card'
      },
      {
        fields: ['status'],
        name: 'idx_orders_status'
      },
      {
        fields: ['order_date'],
        name: 'idx_orders_order_date'
      },
      {
        fields: ['actual_pickup_date'],
        name: 'idx_orders_actual_pickup_date'
      },
      {
        fields: ['pickup_store_code'],
        name: 'idx_orders_pickup_store_code'
      },
      {
        fields: ['tag'],
        name: 'idx_orders_tag'
      },
      {
        fields: ['last_crawled_at'],
        name: 'idx_orders_last_crawled_at'
      },
      {
        using: 'GIN',
        fields: ['products'],
        name: 'idx_orders_products_gin'
      }
    ],
    comment: '订单管理表'
  });

  /**
   * 定义模型关联关系
   * @param {Object} models - 所有模型的集合
   */
  Order.associate = (models) => {
    // 订单关联到Apple账号
    Order.belongsTo(models.AppleId, {
      foreignKey: 'apple_id_ref',
      as: 'appleAccount'
    });

    // 订单关联到收件人
    Order.belongsTo(models.Recipient, {
      foreignKey: 'recipient_ref',
      as: 'recipient'
    });

    // 订单有多个爬虫日志
    Order.hasMany(models.CrawlLog, {
      foreignKey: 'order_id',
      as: 'crawlLogs'
    });
  };

  return Order;
};
