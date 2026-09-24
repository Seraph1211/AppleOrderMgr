/**
 * iPhone 18 报价只读来源库配置。
 * 使用独立变量，避免与本系统 PostgreSQL 配置混淆。
 */
module.exports = Object.freeze({
  host: process.env.QUOTE_SOURCE_DB_HOST || '',
  port: Number.parseInt(process.env.QUOTE_SOURCE_DB_PORT || '3306', 10),
  user: process.env.QUOTE_SOURCE_DB_USER || '',
  password: process.env.QUOTE_SOURCE_DB_PASSWORD || '',
  database: process.env.QUOTE_SOURCE_DB_NAME || 'ppspider_data',
  connectionLimit: Number.parseInt(process.env.QUOTE_SOURCE_DB_POOL_MAX || '3', 10),
  connectTimeout: Number.parseInt(process.env.QUOTE_SOURCE_DB_CONNECT_TIMEOUT || '5000', 10),
});
