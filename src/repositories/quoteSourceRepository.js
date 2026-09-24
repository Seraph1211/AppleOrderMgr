const mysql = require('mysql2/promise');
const config = require('../config/quoteSourceDatabase');

let pool = null;

function validateConfig() {
  if (!config.host || !config.user || !config.password || !config.database) {
    const error = new Error('iPhone 18 报价来源库未配置');
    error.code = 'QUOTE_SOURCE_NOT_CONFIGURED';
    throw error;
  }
}

function getPool() {
  validateConfig();
  if (!pool) {
    pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit,
      connectTimeout: config.connectTimeout,
      timezone: '+08:00',
      charset: 'utf8mb4',
      enableKeepAlive: true,
      waitForConnections: true,
      queueLimit: 20,
    });
  }
  return pool;
}

/**
 * 在显式只读事务中取得最新完整的 iPhone 18 报价批次。
 * @returns {Promise<{items:Object[],sourceUpdatedAt:Date,lastCheckedAt:Date|null}>}
 */
async function fetchLatestIphone18Batch() {
  const connection = await getPool().getConnection();
  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT product_model, storage_gb, color, spec_code, wholesale_price,
              official_price, site_update_time, crawl_time
         FROM quote_hnmwdx_apple
        WHERE product_model IN ('18 Pro', '18 Pro Max')
          AND site_update_time = (
            SELECT site_update_time
             FROM quote_hnmwdx_apple
             WHERE product_model IN ('18 Pro', '18 Pro Max')
             GROUP BY site_update_time
            HAVING COUNT(DISTINCT product_model) = 2
               AND COUNT(*) = 28
               AND SUM(product_model = '18 Pro') = 12
               AND SUM(product_model = '18 Pro Max') = 16
               AND COUNT(DISTINCT CONCAT_WS('|', product_model, storage_gb, color)) = 28
               AND SUM(
                 wholesale_price IS NULL OR official_price IS NULL
                 OR storage_gb IS NULL OR color IS NULL
               ) = 0
             ORDER BY site_update_time DESC
             LIMIT 1
          )
        ORDER BY FIELD(product_model, '18 Pro', '18 Pro Max'), storage_gb,
                 FIELD(color, '黑色', '银色', '冰川蓝色', '勃艮第酒红色')`,
      []
    );
    const [checks] = await connection.execute(
      `SELECT MAX(finished_at) AS last_checked_at
         FROM crawl_job_log
        WHERE spider_name = 'ecommerce.hnmwdx.iphone18'
          AND status IN ('success', 'skipped')`,
      []
    );
    await connection.rollback();
    const items = rows.map(row => ({
      productModel: row.product_model,
      storageGb: Number(row.storage_gb),
      color: row.color,
      specCode: row.spec_code,
      basePrice: Number(row.wholesale_price),
      officialPrice: Number(row.official_price),
      sourceUpdatedAt: row.site_update_time,
      crawledAt: row.crawl_time,
    }));
    return {
      items,
      sourceUpdatedAt: items[0]?.sourceUpdatedAt || null,
      lastCheckedAt: checks[0]?.last_checked_at || null,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_rollbackError) {
      // 原始查询错误优先，回滚失败不覆盖诊断。
    }
    throw error;
  } finally {
    connection.release();
  }
}

/** 关闭报价来源库连接池。 @returns {Promise<void>} */
async function closeQuoteSourcePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

module.exports = { fetchLatestIphone18Batch, closeQuoteSourcePool };
