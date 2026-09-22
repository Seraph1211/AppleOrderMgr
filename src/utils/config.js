/**
 * 配置管理模块
 * 功能：统一管理环境变量和应用配置
 * 作者：Seraph
 * 更新：2026-07-06
 */

require('dotenv').config();

const logger = require('./logger');

const EMAIL_DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const deriveSmtpHost = host =>
  typeof host === 'string' && /^imap\./i.test(host) ? host.replace(/^imap\./i, 'smtp.') : null;

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
    allowedSenderDomains: (process.env.IMAP_ALLOWED_SENDER_DOMAINS || '')
      .split(',')
      .map(domain => domain.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
  },

  // 监控告警发信配置；缺省时复用订单邮箱账号与授权码。
  smtp: {
    host: process.env.SMTP_HOST || deriveSmtpHost(process.env.IMAP_HOST),
    port: parseInt(process.env.SMTP_PORT, 10) || 465,
    secure: process.env.SMTP_SECURE !== 'false',
    user: process.env.SMTP_USER || process.env.IMAP_USER,
    password: process.env.SMTP_PASSWORD || process.env.IMAP_PASSWORD,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || process.env.IMAP_USER,
    reusedFromImap:
      !process.env.SMTP_USER && !process.env.SMTP_PASSWORD && Boolean(process.env.IMAP_USER),
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
};

/**
 * 验证配置完整性
 * 检查运行时必需的配置项是否存在
 * @throws {Error} 当必需配置缺失时抛出异常
 */
const validateConfig = ({ requireImap = true } = {}) => {
  const requiredVars = [];

  if (config.imap.allowedSenderDomains.some(domain => !EMAIL_DOMAIN_PATTERN.test(domain))) {
    logger.error('配置验证失败', { invalidImapAllowedSenderDomain: true });
    throw new Error('IMAP_ALLOWED_SENDER_DOMAINS 包含无效域名');
  }

  // 数据库配置必需（除非提供了 DATABASE_URL）
  if (!config.database.url) {
    requiredVars.push('DB_HOST', 'DB_NAME', 'DB_PASSWORD');
    if (!process.env.DB_USER && !process.env.DB_USERNAME) {
      requiredVars.push('DB_USER');
    }
  }

  // IMAP 配置必需
  if (requireImap) requiredVars.push('IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD');

  try {
    validateRequiredEnvVars(requiredVars);
    logger.info('配置验证通过', {
      env: config.app.env,
      port: config.app.port,
    });
  } catch (error) {
    logger.error('配置验证失败', { error: error.message });
    throw error;
  }
};

module.exports = {
  config,
  validateConfig,
};
