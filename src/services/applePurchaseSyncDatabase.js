const { Sequelize } = require('sequelize');
const config = require('../config/database');

const databases = new Map();

function options(max) {
  return {
    host: config.host,
    port: config.port,
    dialect: 'postgres',
    logging: false,
    pool: {
      max,
      min: 0,
      acquire: config.pool.acquire,
      idle: config.pool.idle,
    },
    dialectOptions: config.dialectOptions,
    timezone: '+08:00',
  };
}

function createDatabase(url, max) {
  if (url) return new Sequelize(url, options(max));
  return new Sequelize(config.database, config.username, config.password, options(max));
}

function getDatabase(kind) {
  if (databases.has(kind)) return databases.get(kind);
  const settings = {
    ingest: { env: 'APPLE_PURCHASE_SYNC_INGEST_DATABASE_URL', max: 3 },
    read: { env: 'APPLE_PURCHASE_SYNC_READ_DATABASE_URL', max: 2 },
    admin: { env: 'APPLE_PURCHASE_SYNC_ADMIN_DATABASE_URL', max: 1 },
  }[kind];
  if (!settings) throw new Error('未知 ApplePurchase 同步数据库用途');
  const dedicatedUrl = process.env[settings.env];
  if (process.env.NODE_ENV === 'production' && !dedicatedUrl) {
    throw new Error(`生产环境缺少 ${settings.env}`);
  }
  const database = createDatabase(dedicatedUrl || config.url, settings.max);
  databases.set(kind, database);
  return database;
}

/** 返回专用写入连接池；生产必须配置最小权限 LOGIN URL。 @returns {Sequelize} 数据库连接 */
function getIngestDatabase() {
  return getDatabase('ingest');
}

/** 返回网页只读连接池。 @returns {Sequelize} 数据库连接 */
function getReadDatabase() {
  return getDatabase('read');
}

/** 返回终端管理连接池。 @returns {Sequelize} 数据库连接 */
function getAdminDatabase() {
  return getDatabase('admin');
}

/** 关闭本模块已创建的全部连接池。 @returns {Promise<void>} 完成 */
async function closeApplePurchaseSyncDatabases() {
  try {
    await Promise.all([...databases.values()].map(database => database.close()));
    databases.clear();
  } catch (error) {
    throw new Error('关闭 ApplePurchase 同步数据库连接失败', { cause: error });
  }
}

/** 为隔离测试替换指定连接，不触碰其他连接池。 @param {string} kind 用途 @param {Object} database 数据库 */
function setDatabaseForTest(kind, database) {
  if (process.env.NODE_ENV !== 'test') throw new Error('仅测试环境允许注入同步数据库');
  databases.set(kind, database);
}

module.exports = {
  closeApplePurchaseSyncDatabases,
  getAdminDatabase,
  getIngestDatabase,
  getReadDatabase,
  setDatabaseForTest,
};
