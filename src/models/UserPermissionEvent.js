const { DataTypes } = require('sequelize');

/**
 * 定义权限变更追加审计模型。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} UserPermissionEvent 模型
 */
module.exports = sequelize => {
  const UserPermissionEvent = sequelize.define(
    'UserPermissionEvent',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      userId: { type: DataTypes.INTEGER, allowNull: false, field: 'user_id' },
      actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
      beforePermissions: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        field: 'before_permissions',
      },
      afterPermissions: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        field: 'after_permissions',
      },
      reason: { type: DataTypes.STRING(500), allowNull: true },
      beforeVersion: { type: DataTypes.INTEGER, allowNull: false, field: 'before_version' },
      afterVersion: { type: DataTypes.INTEGER, allowNull: false, field: 'after_version' },
      idempotencyKey: {
        type: DataTypes.STRING(100),
        allowNull: true,
        field: 'idempotency_key',
      },
      source: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'api' },
    },
    { tableName: 'user_permission_events', underscored: true, timestamps: true }
  );

  UserPermissionEvent.associate = models => {
    UserPermissionEvent.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    UserPermissionEvent.belongsTo(models.User, {
      foreignKey: 'actorUserId',
      as: 'actor',
    });
  };

  return UserPermissionEvent;
};
