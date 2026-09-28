const { DataTypes } = require('sequelize');
/** 定义账号占用区间。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'ProxyAssignment',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      proxyOrderId: DataTypes.INTEGER,
      appleIdRef: DataTypes.INTEGER,
      accountEmail: DataTypes.STRING(255),
      startedAt: DataTypes.DATE,
      endedAt: DataTypes.DATE,
    },
    { tableName: 'proxy_assignments', underscored: true, timestamps: false }
  );
