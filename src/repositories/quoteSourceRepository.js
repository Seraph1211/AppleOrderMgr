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
 * 在显式只读事务中取得最新 iPhone 18 报价批次。
 * 批次的完整性由业务服务按动态结构校验，不在 SQL 中固定商品数量。
 * @returns {Promise<Object>} 最新批次、采集检查时间与最新观测时间
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
            SELECT MAX(site_update_time)
              FROM quote_hnmwdx_apple
             WHERE product_model IN ('18 Pro', '18 Pro Max')
          )
        ORDER BY FIELD(product_model, '18 Pro', '18 Pro Max'), storage_gb,
                 FIELD(color, '黑色', '银色', '冰川蓝色', '勃艮第酒红色')`,
      []
    );
    const [checks] = await connection.execute(
      `SELECT
         (SELECT MAX(finished_at)
            FROM crawl_job_log
           WHERE spider_name = 'ecommerce.hnmwdx.iphone18'
             AND status IN ('success', 'skipped')) AS last_checked_at,
         (SELECT MAX(site_update_time)
            FROM quote_hnmwdx_apple
           WHERE product_model IN ('18 Pro', '18 Pro Max')) AS latest_observed_at`,
      []
    );
    await connection.rollback();
    const items = rows.map(row => ({
      productModel: row.product_model,
      storageGb: Number(row.storage_gb),
      color: row.color,
      specCode: row.spec_code,
      basePrice: row.wholesale_price,
      officialPrice: row.official_price,
      sourceUpdatedAt: row.site_update_time,
      crawledAt: row.crawl_time,
    }));
    return {
      items,
      sourceUpdatedAt: items[0]?.sourceUpdatedAt || null,
      lastCheckedAt: checks[0]?.last_checked_at || null,
      latestObservedAt: checks[0]?.latest_observed_at || null,
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

/** 读取 Duo 最新批次与独立的有效检查时间，不回退历史批次。 @returns {Promise<Object>} 来源批次 */
async function fetchLatestDuoBatch() {
  const connection = await getPool().getConnection();
  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT product_model, storage_gb, color, wholesale_price, official_price,
              site_update_time, crawl_time
         FROM quote_hnmwdx_apple
        WHERE product_model = 'Duo'
          AND site_update_time = (
            SELECT MAX(site_update_time) FROM quote_hnmwdx_apple WHERE product_model = 'Duo'
          )`,
      []
    );
    const [checks] = await connection.execute(
      `SELECT MAX(finished_at) AS last_checked_at FROM crawl_job_log
        WHERE spider_name = 'ecommerce.hnmwdx.duo'
          AND (status = 'success' OR
               (status = 'skipped' AND error_message LIKE '页面更新时间未变化:%'))`,
      []
    );
    await connection.rollback();
    return {
      sourceUpdatedAt: rows[0]?.site_update_time || null,
      lastCheckedAt: checks[0]?.last_checked_at || null,
      items: rows.map(row => ({
        productModel: row.product_model,
        storageGb: Number(row.storage_gb),
        color: row.color,
        wholesalePrice: row.wholesale_price,
        officialPrice: row.official_price,
        sourceUpdatedAt: row.site_update_time,
      })),
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_rollbackError) {
      // 保留原查询错误。
    }
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * 在显式只读事务中读取Duo历史快照，并在范围开始前补入最近一个完整批次。
 * @param {{from?: Date|null,to: Date}} range 时间范围
 * @returns {Promise<{availableFrom: Date|null,sourceUpdatedAt: Date|null,batches:Object[]}>} 历史批次
 */
async function fetchDuoHistory(range) {
  const connection = await getPool().getConnection();
  try {
    const to = range?.to instanceof Date ? range.to : new Date(range?.to);
    const from = range?.from
      ? range.from instanceof Date
        ? range.from
        : new Date(range.from)
      : null;
    if (!Number.isFinite(to.getTime()) || (from && !Number.isFinite(from.getTime()))) {
      throw new TypeError('Duo历史时间范围无效');
    }
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    await connection.beginTransaction();
    const [bounds] = await connection.execute(
      `SELECT MIN(site_update_time) AS available_from,
              MAX(site_update_time) AS source_updated_at
         FROM quote_hnmwdx_apple
        WHERE product_model = 'Duo'`,
      []
    );
    let rows;
    if (from) {
      [rows] = await connection.execute(
        `SELECT product_model, storage_gb, color, wholesale_price, official_price,
                site_update_time
           FROM quote_hnmwdx_apple
          WHERE product_model = 'Duo'
            AND site_update_time <= ?
            AND (
              site_update_time >= ?
              OR site_update_time = (
                SELECT MAX(previous.site_update_time)
                  FROM quote_hnmwdx_apple AS previous
                 WHERE previous.product_model = 'Duo'
                   AND previous.site_update_time < ?
              )
            )
          ORDER BY site_update_time, storage_gb, color`,
        [to, from, from]
      );
    } else {
      [rows] = await connection.execute(
        `SELECT product_model, storage_gb, color, wholesale_price, official_price,
                site_update_time
           FROM quote_hnmwdx_apple
          WHERE product_model = 'Duo'
            AND site_update_time <= ?
          ORDER BY site_update_time, storage_gb, color`,
        [to]
      );
    }
    await connection.rollback();
    const grouped = new Map();
    rows.forEach(row => {
      const timestamp = new Date(row.site_update_time).toISOString();
      if (!grouped.has(timestamp)) grouped.set(timestamp, []);
      grouped.get(timestamp).push({
        productModel: row.product_model,
        storageGb: Number(row.storage_gb),
        color: row.color,
        wholesalePrice: row.wholesale_price,
        officialPrice: row.official_price,
        sourceUpdatedAt: row.site_update_time,
      });
    });
    return {
      availableFrom: bounds[0]?.available_from || null,
      sourceUpdatedAt: bounds[0]?.source_updated_at || null,
      batches: [...grouped.entries()].map(([timestamp, items]) => ({
        sourceUpdatedAt: new Date(timestamp),
        items,
      })),
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_rollbackError) {
      // 保留原始查询错误。
    }
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  fetchLatestIphone18Batch,
  fetchLatestDuoBatch,
  fetchDuoHistory,
  closeQuoteSourcePool,
};
