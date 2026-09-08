const { DataTypes } = require('sequelize');

/**
 * 定义逐用户权限模型。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} UserPermission 模型
 */
module.exports = sequelize => {
  const UserPermission = sequelize.define(
    'UserPermission',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      userId: { type: DataTypes.INTEGER, allowNull: false, field: 'user_id' },
      permissionCode: {
        type: DataTypes.STRING(100),
        allowNull: false,
        field: 'permission_code',
      },
      grantedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'granted_by' },
    },
    { tableName: 'user_permissions', underscored: true, timestamps: true }
  );

  UserPermission.associate = models => {
    UserPermission.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    UserPermission.belongsTo(models.User, { foreignKey: 'grantedBy', as: 'grantor' });
  };

  return UserPermission;
};
