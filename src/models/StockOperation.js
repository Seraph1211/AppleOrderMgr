const { DataTypes } = require('sequelize');

/** 定义自有库存模型，结构通过正式迁移维护。 */
module.exports = sequelize =>
  sequelize.define(
    'StockOperation',
    {
      id: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        field: 'id',
      },
      actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
      actorKey: { type: DataTypes.STRING(40), allowNull: false, field: 'actor_key' },
      requestKey: { type: DataTypes.UUID, allowNull: false, field: 'request_key' },
      action: { type: DataTypes.STRING(64), allowNull: false, field: 'action' },
      requestHash: { type: DataTypes.CHAR(64), allowNull: false, field: 'request_hash' },
      resultRefs: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
        field: 'result_refs',
      },
    },
    { tableName: 'stock_operations', underscored: true, timestamps: true, updatedAt: false }
  );
