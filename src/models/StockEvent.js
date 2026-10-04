const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockEvent',
    {
      id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        primaryKey: true,
        autoIncrement: true,
        field: 'id',
      },
      entityType: { type: DataTypes.STRING(40), allowNull: false, field: 'entity_type' },
      entityId: { type: DataTypes.UUID, allowNull: false, field: 'entity_id' },
      action: { type: DataTypes.STRING(64), allowNull: false, field: 'action' },
      actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
      actorName: { type: DataTypes.STRING(100), allowNull: false, field: 'actor_name' },
      occurredAt: { type: DataTypes.DATE, allowNull: false, field: 'occurred_at' },
      beforeVersion: { type: DataTypes.INTEGER, allowNull: true, field: 'before_version' },
      afterVersion: { type: DataTypes.INTEGER, allowNull: false, field: 'after_version' },
      changesCiphertext: { type: DataTypes.JSONB, allowNull: false, field: 'changes_ciphertext' },
      operationId: { type: DataTypes.UUID, allowNull: false, field: 'operation_id' },
    },
    { tableName: 'stock_events', underscored: true, timestamps: true, updatedAt: false }
  );
