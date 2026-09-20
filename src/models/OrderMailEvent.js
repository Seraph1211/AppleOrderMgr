const { DataTypes } = require('sequelize');

/** 定义逐封订单生命周期邮件的追加式解析／人工核定事件。 */
module.exports = sequelize => {
  const OrderMailEvent = sequelize.define(
    'OrderMailEvent',
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      messageId: { type: DataTypes.UUID, allowNull: false, field: 'message_id' },
      orderId: { type: DataTypes.INTEGER, allowNull: true, field: 'order_id' },
      revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      source: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'parser',
        validate: { isIn: [['parser', 'manual']] },
      },
      actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
      templateType: { type: DataTypes.STRING(50), allowNull: false, field: 'template_type' },
      authenticityStatus: {
        type: DataTypes.STRING(30),
        allowNull: false,
        field: 'authenticity_status',
      },
      orderStatus: { type: DataTypes.STRING(30), allowNull: true, field: 'order_status' },
      paymentStatus: { type: DataTypes.STRING(20), allowNull: true, field: 'payment_status' },
      pickupInfo: { type: DataTypes.JSONB, allowNull: true, field: 'pickup_info' },
      products: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      evidence: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      needsReview: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'needs_review',
      },
      reviewReasons: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        field: 'review_reasons',
      },
      reason: { type: DataTypes.STRING(500), allowNull: true },
      ruleVersion: { type: DataTypes.STRING(50), allowNull: false, field: 'rule_version' },
      parsedAt: { type: DataTypes.DATE, allowNull: false, field: 'parsed_at' },
      appliedAt: { type: DataTypes.DATE, allowNull: true, field: 'applied_at' },
      supersededAt: { type: DataTypes.DATE, allowNull: true, field: 'superseded_at' },
    },
    {
      tableName: 'order_mail_events',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['message_id', 'revision'] },
        { fields: ['order_id', 'parsed_at'] },
        { fields: ['message_id', 'source', 'superseded_at'] },
      ],
    }
  );

  OrderMailEvent.associate = models => {
    OrderMailEvent.belongsTo(models.OrderMailMessage, { foreignKey: 'messageId', as: 'message' });
    OrderMailEvent.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    OrderMailEvent.belongsTo(models.User, { foreignKey: 'actorUserId', as: 'actor' });
  };

  return OrderMailEvent;
};
