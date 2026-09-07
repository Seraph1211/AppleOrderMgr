require('dotenv').config();

module.exports = {
  development: {
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'apple_order_mgr',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
  },
  test: {
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME_TEST || 'apple_order_mgr_test',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
  },
  production: {
    // Sequelize CLI 要求使用此固定 snake_case 配置键。
    // eslint-disable-next-line camelcase
    use_env_variable: process.env.DATABASE_URL ? 'DATABASE_URL' : undefined,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
      ssl:
        process.env.DB_SSL === 'true'
          ? {
            require: true,
            rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
          }
          : false,
    },
    pool: {
      max: parseInt(process.env.DB_POOL_MAX || '5', 10),
      min: parseInt(process.env.DB_POOL_MIN || '0', 10),
      acquire: parseInt(process.env.DB_POOL_ACQUIRE || '30000', 10),
      idle: parseInt(process.env.DB_POOL_IDLE || '10000', 10),
    },
  },
};
