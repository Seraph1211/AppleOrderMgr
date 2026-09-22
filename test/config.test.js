describe('config telegram environment variables', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_ENABLED;
    delete process.env.TELEGRAM_ALERT_ENABLED;
    delete process.env.KDL_TUNNEL_STICKY_PERIOD;
    delete process.env.KDL_TUNNEL_POOL_TYPE;
    delete process.env.KDL_TUNNEL_POOL_PRIORITY;
    delete process.env.FANPROXY_TUNNEL_HOST;
    delete process.env.FANPROXY_TUNNEL_BACKUP_HOST;
    delete process.env.FANPROXY_TUNNEL_PORT;
    delete process.env.FANPROXY_TUNNEL_ACCOUNT;
    delete process.env.FANPROXY_TUNNEL_PASSWORD;
    delete process.env.FANPROXY_TUNNEL_COUNTRY;
    delete process.env.FANPROXY_TUNNEL_REGION;
    delete process.env.FANPROXY_TUNNEL_SESSION_POOL_SIZE;
    delete process.env.FANPROXY_TUNNEL_SESSION_MODE;
    delete process.env.YIYOU_HTTP_PROXY_API_URL;
    delete process.env.YIYOU_HTTP_PROXY_TTL_MS;
    delete process.env.IMAP_ALLOWED_SENDER_DOMAINS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('supports TELEGRAM_ENABLED as primary switch', () => {
    process.env.TELEGRAM_ENABLED = 'true';

    const { config } = require('../src/utils/config');

    expect(config.telegram.enabled).toBe(true);
  });

  test('keeps TELEGRAM_ALERT_ENABLED as compatibility alias', () => {
    process.env.TELEGRAM_ALERT_ENABLED = 'true';

    const { config } = require('../src/utils/config');

    expect(config.telegram.enabled).toBe(true);
  });

  test('解析邮件发件人白名单并标准化大小写', () => {
    process.env.IMAP_ALLOWED_SENDERS = ' Orders@Example.com,helper@example.com ';

    const { config } = require('../src/utils/config');

    expect(config.imap.allowedSenders).toEqual(['orders@example.com', 'helper@example.com']);
  });

  test('解析邮件发件域名白名单并标准化可选的@前缀', () => {
    process.env.IMAP_ALLOWED_SENDER_DOMAINS = ' Lanu.CN, @example.com ';

    const { config } = require('../src/utils/config');

    expect(config.imap.allowedSenderDomains).toEqual(['lanu.cn', 'example.com']);
  });

  test('拒绝无效的邮件发件域名配置', () => {
    process.env.IMAP_ALLOWED_SENDER_DOMAINS = 'evil-lanu.cn/path';

    const { validateConfig } = require('../src/utils/config');

    expect(() => validateConfig()).toThrow('IMAP_ALLOWED_SENDER_DOMAINS 包含无效域名');
  });

  test('生产环境允许不配置发件人白名单', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://integration.invalid/database';
    process.env.IMAP_HOST = 'imap.example.com';
    process.env.IMAP_USER = 'mailbox@example.com';
    process.env.IMAP_PASSWORD = 'synthetic-imap-password';
    process.env.PROXY_ENABLED = 'false';
    delete process.env.IMAP_ALLOWED_SENDERS;
    delete process.env.IMAP_ALLOWED_SENDER_DOMAINS;

    const { config, validateConfig } = require('../src/utils/config');

    expect(config.imap.allowedSenders).toEqual([]);
    expect(config.imap.allowedSenderDomains).toEqual([]);
    expect(() => validateConfig()).not.toThrow();
  });

});
