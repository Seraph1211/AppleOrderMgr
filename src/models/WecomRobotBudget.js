const { DataTypes } = require('sequelize');

/** 定义通知持久化模型。 @param {Object} sequelize 数据库 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'WecomRobotBudget',
    {
      fingerprint: { type: DataTypes.CHAR(64), primaryKey: true, field: 'fingerprint' },
      reservations: { type: DataTypes.JSONB, field: 'reservations' },
      waiters: { type: DataTypes.JSONB, field: 'waiters' },
      nextSendAt: { type: DataTypes.DATE, field: 'next_send_at' },
      storm: { type: DataTypes.JSONB, field: 'storm' },
    },
    { tableName: 'wecom_robot_budgets', underscored: true, timestamps: true }
  );
