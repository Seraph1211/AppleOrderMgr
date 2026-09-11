const { DataTypes } = require('sequelize');

/**
 * 定义 AOS TAG 自动分配规则模型。
 * @param {Object} sequelize 数据库实例
 * @returns {Object} 模型
 */
module.exports = sequelize => {
  const PaymentTagRule = sequelize.define(
    'PaymentTagRule',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(100), allowNull: false },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      recipientTags: { type: DataTypes.JSONB, allowNull: false, field: 'recipient_tags' },
      assigneeUserIds: { type: DataTypes.JSONB, allowNull: false, field: 'assignee_user_ids' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'payment_tag_rules', underscored: true, timestamps: true }
  );
  PaymentTagRule.associate = models => {
    PaymentTagRule.belongsTo(models.User, { foreignKey: 'updatedBy', as: 'updater' });
  };
  return PaymentTagRule;
};
