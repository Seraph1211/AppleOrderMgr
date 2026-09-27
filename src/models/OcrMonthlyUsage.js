const { DataTypes } = require('sequelize');

/** 定义北京时间自然月 OCR 调用预算。 */
module.exports = sequelize =>
  sequelize.define(
    'OcrMonthlyUsage',
    {
      month: { type: DataTypes.STRING(7), primaryKey: true },
      used: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'ocr_monthly_usage', timestamps: false }
  );
