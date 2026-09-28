const { DataTypes } = require('sequelize');
const { encrypt, decrypt } = require('../utils/fieldEncryption');

/** 定义客户代抢委托。 @param {Object} sequelize 连接 @returns {Object} 模型 */
module.exports = sequelize =>
  sequelize.define(
    'ProxyOrder',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      platformOrderNumber: DataTypes.STRING(100),
      lastName: DataTypes.STRING(50),
      firstName: DataTypes.STRING(50),
      phone: DataTypes.STRING(20),
      email: DataTypes.STRING(255),
      idLast4: DataTypes.STRING(4),
      productModel: DataTypes.STRING(100),
      color: DataTypes.STRING(100),
      storage: DataTypes.STRING(20),
      quantity: DataTypes.INTEGER,
      storeCodes: DataTypes.JSONB,
      storeMode: DataTypes.STRING(20),
      storeCity: DataTypes.STRING(100),
      billing: DataTypes.JSONB,
      paymentMethod: DataTypes.STRING(50),
      notes: DataTypes.TEXT,
      rawText: {
        type: DataTypes.TEXT,
        set(value) {
          this.setDataValue('rawText', encrypt(value));
        },
        get() {
          return decrypt(this.getDataValue('rawText'));
        },
      },
      status: { type: DataTypes.STRING(20), defaultValue: 'pending' },
      orderId: DataTypes.INTEGER,
      anomaly: DataTypes.TEXT,
      rejectedOrderIds: { type: DataTypes.JSONB, defaultValue: [] },
      version: { type: DataTypes.INTEGER, defaultValue: 1 },
      createdBy: DataTypes.INTEGER,
    },
    { tableName: 'proxy_orders', underscored: true }
  );
