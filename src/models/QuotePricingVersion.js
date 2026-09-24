const { DataTypes } = require('sequelize');

/** 定义公开报价调价版本快照。 @param {Object} sequelize 数据库连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'QuotePricingVersion',
    {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
      revision: { type: DataTypes.INTEGER, allowNull: false, unique: true },
      action: { type: DataTypes.STRING(30), allowNull: false },
      snapshot: { type: DataTypes.JSONB, allowNull: false },
      summary: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
      actorName: { type: DataTypes.STRING(100), allowNull: false, field: 'actor_name' },
    },
    {
      tableName: 'quote_pricing_versions',
      underscored: true,
      timestamps: true,
      updatedAt: false,
    }
  );
