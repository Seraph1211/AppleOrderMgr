const { calculateCatalogAmount } = require('../utils/orderCatalogPricingV1');
const { buildProductFilterItems } = require('../utils/productFilter');
const { DataTypes } = require('sequelize');
const { encrypt, decrypt } = require('../utils/fieldEncryption');
const { EMAIL_ORDER_STATUSES, ORDER_STATUSES } = require('../constants/business');

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
module.exports = sequelize => {
  const Order = sequelize.define(
    'Order',
    {
      ingestionSource: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'unknown',
        field: 'ingestion_source',
      },
      sourceRecipientTag: { type: DataTypes.STRING(500), field: 'source_recipient_tag' },
      sourceContactEmail: { type: DataTypes.STRING(255), field: 'source_contact_email' },
      sourceLastName: { type: DataTypes.STRING(50), field: 'source_last_name' },
      sourceFirstName: { type: DataTypes.STRING(50), field: 'source_first_name' },
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID，自增',
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
            args: /^W\d{10}$/,
            msg: '订单号必须是W开头后跟10位数字',
          },
        },
      },
      // Apple ID 相关
      appleIdRef: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'apple_id_ref',
        comment: '关联到apple_ids表的外键',
        references: {
          model: 'apple_ids',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      appleId: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'apple_id',
        comment: 'Apple ID（邮件解析）',
      },
      applePassword: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'apple_password',
        comment: 'Apple ID 密码快照（AES-256-GCM 密文）',
        set(value) {
          this.setDataValue('applePassword', encrypt(value));
        },
        get() {
          return decrypt(this.getDataValue('applePassword'));
        },
      },
      // 收件人相关（快照 - 自动匹配填充）
      recipientRef: {
        type: DataTypes.INTEGER,
        allowNull: true,
        field: 'recipient_ref',
        comment: '关联到recipients表的外键',
        references: {
          model: 'recipients',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      recipientName: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'recipient_name',
        comment: '收件人姓名（邮件解析）',
      },
      recipientIdLast4: {
        type: DataTypes.STRING(4),
        field: 'recipient_id_last4',
        comment: '来源身份证后四位',
      },
      recipientIdCard: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'recipient_id_card',
        comment: '收件人身份证快照（AES-256-GCM 密文）',
        set(value) {
          this.setDataValue('recipientIdCard', encrypt(value));
        },
        get() {
          return decrypt(this.getDataValue('recipientIdCard'));
        },
      },
      recipientEmail: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'recipient_email',
        comment: '收件人邮箱（从 recipients 表匹配填充）',
      },
      recipientPhone: {
        type: DataTypes.STRING(20),
        allowNull: true,
        field: 'recipient_phone',
        comment: '收件人手机号（从 recipients 表匹配填充）',
      },
      recipientAddress: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'recipient_address',
        comment: '收件人完整地址（从 recipients 表匹配填充）',
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
              if (!product.name || !Number.isInteger(product.quantity) || product.quantity < 0) {
                throw new Error(`products[${index}]缺少必要字段：name、quantity`);
              }
            });
          },
        },
      },
      productFilterItems: {
        type: DataTypes.JSONB,
        field: 'product_filter_items',
        allowNull: false,
        defaultValue: [],
        comment: '独立商品筛选索引，不依赖官网抓取',
      },
      sourceSnapshot: {
        type: DataTypes.JSONB,
        field: 'source_snapshot',
        allowNull: true,
        defaultValue: null,
        comment: '入库来源的非敏感快照',
      },
      officialRawStatus: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'official_raw_status',
        comment: '手动查询的官网商品原始状态，多种状态以 | 分隔',
      },
      officialStatusObservedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'official_status_observed_at',
        comment: '最近一次完整官网响应的观测时间',
      },
      // 订单状态
      status: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'pending',
        comment: '订单状态',
        validate: {
          isIn: {
            args: [ORDER_STATUSES],
            msg: '订单状态必须是有效值',
          },
        },
      },
      orderUrl: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'order_url',
        comment: 'Apple订单查询链接',
        validate: {
          isUrl: {
            msg: '订单链接必须是有效的URL',
          },
        },
      },
      // 支付信息
      paymentMethod: {
        type: DataTypes.STRING(50),
        allowNull: true,
        field: 'payment_method',
        comment: '付款方式',
      },
      emailOrderStatus: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'unknown',
        field: 'email_order_status',
        comment: '官方订单邮件归并的订单阶段',
        validate: { isIn: [EMAIL_ORDER_STATUSES] },
      },
      emailPaymentStatus: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'unknown',
        field: 'email_payment_status',
        comment: '官方订单邮件归并的付款状态',
        validate: { isIn: [['unknown', 'paid']] },
      },
      emailStatusNeedsReview: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'email_status_needs_review',
        comment: '邮件结论存在冲突或证据不足',
      },
      emailStatusReviewReasons: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        field: 'email_status_review_reasons',
        comment: '邮件状态待核对原因码',
      },
      emailStatusVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'email_status_version',
        comment: '邮件状态乐观锁版本',
      },
      emailStatusEvidenceAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'email_status_evidence_at',
        comment: '最近有效邮件证据的发信时间',
      },
      emailPickupInfo: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'email_pickup_info',
        comment: '邮件取货门店、地址、日期、时段和逐字段证据',
      },
      emailPickupDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'email_pickup_date',
        comment: '邮件明确的当前有效取货日期',
      },
      emailLifecycleUpdatedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'email_lifecycle_updated_at',
        comment: '最近一次邮件归并应用时间',
      },
      paymentAssignmentHoldReason: {
        type: DataTypes.STRING(50),
        allowNull: true,
        field: 'payment_assignment_hold_reason',
        comment: '独立付款分配限制原因；不得由通用订单编辑接口清除',
        validate: { isIn: [['legacy_payment_restriction']] },
      },
      paymentAssignmentHoldEvidence: {
        type: DataTypes.JSONB,
        allowNull: true,
        field: 'payment_assignment_hold_evidence',
        comment: '付款限制的非敏感迁移证据和归档引用',
      },
      orderAmount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
        field: 'order_amount',
        comment: '按已确认价格映射计算的订单金额，未知为 null',
      },
      orderAmountPriceVersion: {
        type: DataTypes.STRING(40),
        allowNull: true,
        field: 'order_amount_price_version',
        comment: '订单金额所用价格映射版本',
      },
      payerName: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'payer_name',
        comment: '付款人姓名',
      },
      payerVersion: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'payer_version',
        comment: '付款人关联乐观锁版本',
        validate: { min: 0 },
      },
      paymentScreenshot: {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: [],
        field: 'payment_screenshot',
        comment: '付款截图URL数组（支持多张图片）',
      },
      // 取货信息
      pickupStore: {
        type: DataTypes.STRING(255),
        allowNull: true,
        field: 'pickup_store',
        comment: '取货门店',
      },
      pickupStoreCode: {
        type: DataTypes.STRING(50),
        allowNull: true,
        field: 'pickup_store_code',
        comment: '取货门店代码（如 R638）',
      },
      // 时间信息
      orderDate: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'order_date',
        comment: '下单时间（来自邮件）',
      },
      // 业务字段
      tag: {
        type: DataTypes.STRING(500),
        allowNull: true,
        comment: '订单标签',
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '备注',
      },
      // 时间戳
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
        comment: '记录创建时间',
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'updated_at',
        comment: '记录更新时间',
      },
    },
    {
      hooks: {
        beforeSave(order, options) {
          if (
            order.isNewRecord ||
            (order.changed('products') && (!options.fields || options.fields.includes('products')))
          ) {
            Object.assign(order, calculateCatalogAmount(order.products));
            for (const field of ['orderAmount', 'orderAmountPriceVersion'])
              if (options.fields && !options.fields.includes(field)) options.fields.push(field);
          }
          if (order.isNewRecord || order.changed('products') || order.changed('sourceSnapshot')) {
            order.productFilterItems = buildProductFilterItems(
              order.products,
              order.productFilterItems,
              order.sourceSnapshot?.products
            );
            if (options.fields && !options.fields.includes('productFilterItems'))
              options.fields.push('productFilterItems');
          }
        },
        beforeBulkCreate(orders, options) {
          for (const order of orders) Object.assign(order, calculateCatalogAmount(order.products));
          for (const field of ['orderAmount', 'orderAmountPriceVersion']) {
            if (options.fields && !options.fields.includes(field)) options.fields.push(field);
            if (
              options.updateOnDuplicate?.includes('products') &&
              !options.updateOnDuplicate.includes(field)
            )
              options.updateOnDuplicate.push(field);
          }
          for (const order of orders)
            order.productFilterItems = buildProductFilterItems(
              order.products,
              order.productFilterItems,
              order.sourceSnapshot?.products
            );
        },
        beforeBulkUpdate(options) {
          if (Object.hasOwn(options.attributes, 'products') || options.attributes.sourceSnapshot)
            options.individualHooks = true;
        },
      },
      tableName: 'orders',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          unique: true,
          fields: ['order_number'],
          name: 'uk_order_number',
        },
        {
          fields: ['apple_id_ref'],
          name: 'idx_orders_apple_id_ref',
        },
        {
          fields: ['apple_id'],
          name: 'idx_orders_apple_id',
        },
        {
          fields: ['recipient_ref'],
          name: 'idx_orders_recipient_ref',
        },
        {
          fields: ['recipient_name'],
          name: 'idx_orders_recipient_name',
        },
        {
          fields: ['recipient_id_card'],
          name: 'idx_orders_recipient_id_card',
        },
        {
          fields: ['status'],
          name: 'idx_orders_status',
        },
        { fields: ['email_order_status'], name: 'idx_orders_email_order_status' },
        { fields: ['email_payment_status'], name: 'idx_orders_email_payment_status' },
        { fields: ['email_pickup_date'], name: 'idx_orders_email_pickup_date' },
        {
          fields: ['order_date'],
          name: 'idx_orders_order_date',
        },
        {
          fields: ['pickup_store_code'],
          name: 'idx_orders_pickup_store_code',
        },
        {
          fields: ['tag'],
          name: 'idx_orders_tag',
        },
        {
          using: 'GIN',
          fields: ['products'],
          name: 'idx_orders_products_gin',
        },
      ],
      comment: '订单管理表',
    }
  );

  /**
   * 定义模型关联关系
   * @param {Object} models - 所有模型的集合
   */
  Order.associate = models => {
    // 订单关联到Apple账号
    Order.belongsTo(models.AppleId, {
      foreignKey: 'appleIdRef',
      as: 'appleAccount',
    });

    // 订单关联到收件人
    Order.belongsTo(models.Recipient, {
      foreignKey: 'recipientRef',
      as: 'recipient',
    });

    Order.hasMany(models.EmailLog, {
      foreignKey: 'orderId',
      as: 'emailLogs',
    });
    Order.hasOne(models.PaymentTask, {
      foreignKey: 'orderId',
      as: 'paymentTask',
    });
    Order.hasMany(models.OrderPayerEvent, {
      foreignKey: 'orderId',
      as: 'payerEvents',
    });
    Order.hasMany(models.OrderMailEvent, {
      foreignKey: 'orderId',
      as: 'mailEvents',
    });
    Order.hasOne(models.PickupRecord, { foreignKey: 'orderId', as: 'pickupRecord' });
  };

  return Order;
};
