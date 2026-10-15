const { DataTypes } = require('sequelize');
/** 定义可追溯的官方订单关联。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'ProxyOrderLink',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      proxyOrderId: DataTypes.INTEGER,
      orderId: DataTypes.INTEGER,
      source: DataTypes.STRING(20),
      actorId: DataTypes.INTEGER,
      linkedAt: DataTypes.DATE,
      unlinkedAt: DataTypes.DATE,
      reasonEncrypted: DataTypes.TEXT,
    },
    { tableName: 'proxy_order_links', underscored: true, timestamps: false }
  );
