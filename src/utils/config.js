/**
 * 配置管理模块
 * 功能：统一管理环境变量和应用配置
 * 作者：Seraph
 * 更新：2026-07-06
 */

require('dotenv').config();

const logger = require('./logger');
const { isSupportedProxyProvider } = require('../services/crawler/proxy/proxyProvider');

/**
 * 验证必需的环境变量
 * @param {string[]} requiredVars - 必需的环境变量列表
 * @throws {Error} 当必需的环境变量缺失时抛出异常
 */
const validateRequiredEnvVars = requiredVars => {
  const missing = requiredVars.filter(varName => !process.env[varName]);

  if (missing.length > 0) {
    const errorMsg = `缺少必需的环境变量: ${missing.join(', ')}`;
    logger.error('配置验证失败', { missing });
    throw new Error(errorMsg);
  }
};

/**
 * 应用配置对象
 * 包含所有应用级配置项，从环境变量读取并提供默认值
 */
const config = {
  // 应用基础配置
  app: {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 3000,
    logLevel: process.env.LOG_LEVEL || 'info',
  },

  // 数据库配置
  database: {
    url: process.env.DATABASE_URL,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    name: process.env.DB_NAME || 'apple_order_manager',
    username: process.env.DB_USER || process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD,
    dialect: 'postgres',
    pool: {
      max: parseInt(process.env.DB_POOL_MAX, 10) || 5,
      min: parseInt(process.env.DB_POOL_MIN, 10) || 0,
      acquire: parseInt(process.env.DB_POOL_ACQUIRE, 10) || 30000,
      idle: parseInt(process.env.DB_POOL_IDLE, 10) || 10000,
    },
    logging: process.env.DB_LOGGING === 'true',
  },

  // IMAP 邮件配置
  imap: {
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT, 10) || 993,
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASSWORD,
    tls: process.env.IMAP_TLS !== 'false',
    tlsOptions: {
      rejectUnauthorized: process.env.IMAP_TLS_REJECT_UNAUTHORIZED !== 'false',
    },
    mailbox: process.env.IMAP_MAILBOX || 'INBOX',
    searchCriteria: ['UNSEEN'],
    markSeen: process.env.IMAP_MARK_SEEN !== 'false',
    allowedSenders: (process.env.IMAP_ALLOWED_SENDERS || '')
      .split(',')
      .map(sender => sender.trim().toLowerCase())
      .filter(Boolean),
  },

  // 爬虫配置
  crawler: {
    requestDelay: {
      min: parseInt(process.env.CRAWLER_DELAY_MIN, 10) || 5000,
      max: parseInt(process.env.CRAWLER_DELAY_MAX, 10) || 10000,
    },
    maxRetry: parseInt(process.env.CRAWLER_MAX_RETRY, 10) || 3,
    timeout: parseInt(process.env.CRAWLER_TIMEOUT, 10) || 30000,
    requestsPerSecond: parseInt(process.env.CRAWLER_REQUESTS_PER_SECOND, 10) || 5,
    workerConcurrency: parseInt(process.env.CRAWLER_WORKER_CONCURRENCY, 10) || 8,
    schedulerTickMs: parseInt(process.env.CRAWLER_SCHEDULER_TICK_MS, 10) || 5000,
    jobLeaseMs: parseInt(process.env.CRAWLER_JOB_LEASE_MS, 10) || 300000,
    scheduleScanLimit: parseInt(process.env.CRAWLER_SCHEDULE_SCAN_LIMIT, 10) || 500,
    retryDelayMinMs: parseInt(process.env.CRAWLER_RETRY_DELAY_MIN_MS, 10) || 1000,
    retryDelayMaxMs: parseInt(process.env.CRAWLER_RETRY_DELAY_MAX_MS, 10) || 5000,
    autoRefreshEnabled: process.env.AUTO_ORDER_REFRESH_ENABLED === 'true',
    autoRefreshIntervalMs: parseInt(process.env.AUTO_ORDER_REFRESH_INTERVAL_MS, 10) || 300000,
    windControlPauseThreshold: parseInt(process.env.CRAWLER_WIND_CONTROL_PAUSE_THRESHOLD, 10) || 2,
    userAgent:
      process.env.CRAWLER_USER_AGENT ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },

  // Telegram 告警配置（仅从环境变量读取）
  telegram: {
    enabled:
      process.env.TELEGRAM_ENABLED === 'true' || process.env.TELEGRAM_ALERT_ENABLED === 'true',
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    proxyUrl: process.env.TELEGRAM_PROXY_URL,
    timeout: parseInt(process.env.TELEGRAM_TIMEOUT, 10) || 10000,
    heartbeat: {
      enabled: process.env.TELEGRAM_HEARTBEAT_ENABLED === 'true',
      intervalMs: parseInt(process.env.TELEGRAM_HEARTBEAT_INTERVAL_MS, 10) || 300000,
      quietStart: process.env.TELEGRAM_HEARTBEAT_QUIET_START || null,
      quietEnd: process.env.TELEGRAM_HEARTBEAT_QUIET_END || null,
    },
  },

  // 代理池配置
  proxy: {
    enabled: process.env.PROXY_ENABLED === 'true',
    provider: process.env.PROXY_PROVIDER || 'kdl_private',
    apiUrl: process.env.PROXY_API_URL,
    apiKey: process.env.PROXY_API_KEY,
    refreshInterval: parseInt(process.env.PROXY_REFRESH_INTERVAL, 10) || 3600000, // 1小时
    badProxyTimeout: parseInt(process.env.PROXY_BAD_TIMEOUT, 10) || 3600000, // 1小时
    maxFailCount: parseInt(process.env.PROXY_MAX_FAIL_COUNT, 10) || 2,
    tunnel: {
      host: process.env.KDL_TUNNEL_HOST,
      backupHost: process.env.KDL_TUNNEL_BACKUP_HOST,
      port: parseInt(process.env.KDL_TUNNEL_PORT, 10) || null,
      username: process.env.KDL_TUNNEL_USERNAME,
      password: process.env.KDL_TUNNEL_PASSWORD,
      stickyPeriod: process.env.KDL_TUNNEL_STICKY_PERIOD || '0.5',
      poolType: process.env.KDL_TUNNEL_POOL_TYPE || 'std',
      poolPriority: process.env.KDL_TUNNEL_POOL_PRIORITY || 'q10',
    },
  },

  // 定时任务配置
  cron: {
    orderSync: process.env.CRON_ORDER_SYNC || '0 */6 * * *', // 每6小时
    proxyRefresh: process.env.CRON_PROXY_REFRESH || '0 * * * *', // 每小时
  },
};

/**
 * 验证配置完整性
 * 检查运行时必需的配置项是否存在
 * @throws {Error} 当必需配置缺失时抛出异常
 */
const validateConfig = () => {
  const requiredVars = [];

  if (config.proxy.enabled && !isSupportedProxyProvider(config.proxy.provider)) {
    logger.error('配置验证失败', { invalidProxyProvider: true });
    throw new Error('PROXY_PROVIDER 必须是 kdl_tunnel 或 kdl_private');
  }

  // 数据库配置必需（除非提供了 DATABASE_URL）
  if (!config.database.url) {
    requiredVars.push('DB_HOST', 'DB_NAME', 'DB_PASSWORD');
    if (!process.env.DB_USER && !process.env.DB_USERNAME) {
      requiredVars.push('DB_USER');
    }
  }

  // IMAP 配置必需
  requiredVars.push('IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD');

  // 生产环境下，代理配置必需
  if (config.app.env === 'production' && config.proxy.enabled) {
    if (config.proxy.provider === 'kdl_tunnel') {
      requiredVars.push(
        'KDL_TUNNEL_HOST',
        'KDL_TUNNEL_PORT',
        'KDL_TUNNEL_USERNAME',
        'KDL_TUNNEL_PASSWORD'
      );
    } else {
      requiredVars.push('PROXY_API_URL');
    }
  }

  try {
    validateRequiredEnvVars(requiredVars);
    logger.info('配置验证通过', {
      env: config.app.env,
      port: config.app.port,
      proxyEnabled: config.proxy.enabled,
    });
  } catch (error) {
    logger.error('配置验证失败', { error: error.message });
    throw error;
  }
};

/**
 * 获取随机延迟时间（用于爬虫反爬）
 * @returns {number} 随机延迟时间（毫秒）
 */
const getRandomDelay = () => {
  const { min, max } = config.crawler.requestDelay;
  return Math.floor(Math.random() * (max - min)) + min;
};

module.exports = {
  config,
  validateConfig,
  getRandomDelay,
};
