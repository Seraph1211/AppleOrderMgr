const crypto = require('crypto');
const fs = require('fs');

/** 独立订单邮件配置；不回退到建单邮箱或监控发信凭据。 */
function getOrderMailConfig() {
  const user = process.env.ORDER_MAIL_USER || '';
  const password = process.env.ORDER_MAIL_PASSWORD_FILE
    ? fs.readFileSync(process.env.ORDER_MAIL_PASSWORD_FILE, 'utf8').trim()
    : process.env.ORDER_MAIL_PASSWORD || '';
  const host = process.env.ORDER_MAIL_IMAP_HOST || '';
  const mailbox = process.env.ORDER_MAIL_MAILBOX || 'INBOX';
  return {
    enabled: process.env.ORDER_MAIL_ENABLED === 'true',
    imap: {
      user,
      password,
      host,
      mailbox,
      port: Number(process.env.ORDER_MAIL_IMAP_PORT || 993),
      tls: true,
      tlsOptions: { rejectUnauthorized: true },
    },
    smtp: {
      host: process.env.ORDER_MAIL_SMTP_HOST || '',
      port: Number(process.env.ORDER_MAIL_SMTP_PORT || 465),
      secure: true,
      auth: { user, pass: password },
      tls: { rejectUnauthorized: true },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 60000,
      disableFileAccess: true,
      disableUrlAccess: true,
    },
    from: user,
    lookbackDays: Math.min(365, Math.max(1, Number(process.env.ORDER_MAIL_LOOKBACK_DAYS) || 30)),
    senderDomains: (process.env.ORDER_MAIL_SENDER_DOMAINS || 'apple.com,apple.com.cn')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
    lifecycle: {
      parseEnabled: process.env.ORDER_MAIL_LIFECYCLE_PARSE_ENABLED !== 'false',
      applyEnabled: process.env.ORDER_MAIL_LIFECYCLE_APPLY_ENABLED === 'true',
      paymentTaskApplyEnabled:
        process.env.ORDER_MAIL_LIFECYCLE_APPLY_ENABLED === 'true' &&
        process.env.ORDER_MAIL_PAYMENT_TASK_APPLY_ENABLED === 'true',
    },
    identity: crypto
      .createHash('sha256')
      .update(JSON.stringify(['order-mail', host.toLowerCase(), user.toLowerCase(), mailbox]))
      .digest('hex'),
  };
}

/** 校验收发信所需配置是否齐全。 */
function isOrderMailConfigured(config = getOrderMailConfig()) {
  return Boolean(
    config.enabled &&
    config.imap.host &&
    config.imap.user &&
    config.imap.password &&
    config.smtp.host
  );
}

module.exports = { getOrderMailConfig, isOrderMailConfigured };
