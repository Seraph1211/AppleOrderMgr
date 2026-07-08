require('dotenv').config();

/**
 * 数据库配置
 * @module config/database
 * @description Sequelize数据库连接配置
 */

module.exports = {
  // 数据库连接信息
  database: process.env.DB_NAME || 'apple_order_mgr',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  dialect: 'postgres',

  // 连接池配置
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000
  },

  // 日志配置
  logging: process.env.NODE_ENV === 'production' ? false : console.log,

  // 模型默认配置
  define: {
    timestamps: true,
    underscored: true,
    freezeTableName: true,
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci'
  },

  // PostgreSQL特定配置
  dialectOptions: {
    ssl: process.env.DB_SSL === 'true' ? {
      require: true,
      rejectUnauthorized: false
    } : false,
    supportBigNumbers: true,
    bigNumberStrings: true
  },

  // 时区配置
  timezone: '+08:00'
};
