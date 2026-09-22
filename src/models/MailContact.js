const { DataTypes } = require('sequelize');

/** 定义全局邮件联系人。 */
module.exports = sequelize =>
  sequelize.define(
    'MailContact',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(100), allowNull: false },
      email: { type: DataTypes.STRING(254), allowNull: false, unique: true },
    },
    { tableName: 'mail_contacts', underscored: true, timestamps: true }
  );
