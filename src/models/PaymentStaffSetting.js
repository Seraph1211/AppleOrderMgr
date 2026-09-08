const { DataTypes } = require('sequelize');

/**
 * 定义逐用户付款接单配置模型。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} PaymentStaffSetting 模型
 */
module.exports = sequelize => {
  const PaymentStaffSetting = sequelize.define(
    'PaymentStaffSetting',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      userId: { type: DataTypes.INTEGER, allowNull: false, unique: true, field: 'user_id' },
      autoAssignEnabled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'auto_assign_enabled',
      },
      maxActiveTasks: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'max_active_tasks',
        validate: { min: 0, max: 1000 },
      },
      lastAssignedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_assigned_at' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'payment_staff_settings', underscored: true, timestamps: true }
  );

  PaymentStaffSetting.associate = models => {
    PaymentStaffSetting.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    PaymentStaffSetting.belongsTo(models.User, { foreignKey: 'updatedBy', as: 'updater' });
  };

  return PaymentStaffSetting;
};
