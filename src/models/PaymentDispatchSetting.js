const { DataTypes } = require('sequelize');

/**
 * 定义付款调度单例配置模型。
 * @param {import('sequelize').Sequelize} sequelize - Sequelize 实例
 * @returns {import('sequelize').Model} PaymentDispatchSetting 模型
 */
module.exports = sequelize => {
  const PaymentDispatchSetting = sequelize.define(
    'PaymentDispatchSetting',
    {
      id: { type: DataTypes.SMALLINT, primaryKey: true, defaultValue: 1 },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      mode: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'manual',
        validate: { isIn: [['manual', 'auto']] },
      },
      scopeStartedAt: { type: DataTypes.DATE, allowNull: true, field: 'scope_started_at' },
      freshnessSeconds: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 90,
        field: 'freshness_seconds',
      },
      eligibilitySeconds: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 300,
        field: 'eligibility_seconds',
      },
      pendingReminderSeconds: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 120,
        field: 'pending_reminder_seconds',
      },
      warningSeconds: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 600,
        field: 'warning_seconds',
      },
      urgentSeconds: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 300,
        field: 'urgent_seconds',
      },
      lastScanAt: { type: DataTypes.DATE, allowNull: true, field: 'last_scan_at' },
      lastErrorCode: { type: DataTypes.STRING(50), allowNull: true, field: 'last_error_code' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      updatedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'payment_dispatch_settings', underscored: true, timestamps: true }
  );

  PaymentDispatchSetting.associate = models => {
    PaymentDispatchSetting.belongsTo(models.User, {
      foreignKey: 'updatedBy',
      as: 'updater',
    });
  };

  return PaymentDispatchSetting;
};
