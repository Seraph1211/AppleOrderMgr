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

  test('生产环境未显式开启时也保持订单自动刷新关闭', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AUTO_ORDER_REFRESH_ENABLED;

    const { config } = require('../src/utils/config');

    expect(config.crawler.autoRefreshEnabled).toBe(false);
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

  test('读取隧道代理 Provider 配置但不提供凭据默认值', () => {
    process.env.PROXY_PROVIDER = 'kdl_tunnel';
    process.env.KDL_TUNNEL_HOST = 'primary.example';
    process.env.KDL_TUNNEL_PORT = '15818';
    delete process.env.KDL_TUNNEL_PASSWORD;

    const { config } = require('../src/utils/config');

    expect(config.proxy.provider).toBe('kdl_tunnel');
    expect(config.proxy.tunnel).toMatchObject({
      host: 'primary.example',
      port: 15818,
      stickyPeriod: '0.5',
      poolType: 'std',
      poolPriority: 'q10',
    });
    expect(config.proxy.tunnel.password).toBeUndefined();
  });

  test('未显式配置 Provider 时默认选择网帆隧道', () => {
    delete process.env.PROXY_PROVIDER;

    const { config } = require('../src/utils/config');

    expect(config.proxy.provider).toBe('fanproxy_tunnel');
  });

  test('代理启用时拒绝未知 Provider 配置', () => {
    process.env.PROXY_ENABLED = 'true';
    process.env.PROXY_PROVIDER = 'unknown';

    const { validateConfig } = require('../src/utils/config');

    expect(() => validateConfig()).toThrow(
      'PROXY_PROVIDER 必须是 fanproxy_tunnel、kdl_tunnel、kdl_private、yiyou_http'
    );
  });

  test('读取网帆隧道配置且不为账密提供默认值', () => {
    process.env.PROXY_PROVIDER = 'fanproxy_tunnel';
    process.env.FANPROXY_TUNNEL_HOST = 'fanproxy.example';
    process.env.FANPROXY_TUNNEL_PORT = '9000';
    process.env.FANPROXY_TUNNEL_ACCOUNT = 'testaccount';
    process.env.FANPROXY_TUNNEL_COUNTRY = 'cn';
    process.env.FANPROXY_TUNNEL_REGION = '32';
    process.env.FANPROXY_TUNNEL_SESSION_POOL_SIZE = '5';
    process.env.FANPROXY_TUNNEL_SESSION_MODE = 'sticky_pool';
    delete process.env.FANPROXY_TUNNEL_PASSWORD;

    const { config } = require('../src/utils/config');

    expect(config.proxy.provider).toBe('fanproxy_tunnel');
    expect(config.proxy.fanproxyTunnel).toMatchObject({
      host: 'fanproxy.example',
      port: 9000,
      account: 'testaccount',
      country: 'cn',
      region: '32',
      sessionPoolSize: 5,
      sessionMode: 'sticky_pool',
    });
    expect(config.proxy.fanproxyTunnel.password).toBeUndefined();
  });

  test('生产启用网帆隧道时要求完整账密配置', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://integration.invalid/database';
    process.env.IMAP_HOST = 'imap.example.com';
    process.env.IMAP_USER = 'mailbox@example.com';
    process.env.IMAP_PASSWORD = 'synthetic-imap-password';
    process.env.PROXY_ENABLED = 'true';
    process.env.PROXY_PROVIDER = 'fanproxy_tunnel';
    process.env.FANPROXY_TUNNEL_HOST = 'fanproxy.example';
    process.env.FANPROXY_TUNNEL_PORT = '9000';
    process.env.FANPROXY_TUNNEL_ACCOUNT = 'testaccount';
    delete process.env.FANPROXY_TUNNEL_PASSWORD;

    const { validateConfig } = require('../src/utils/config');

    expect(() => validateConfig()).toThrow('缺少必需的环境变量: FANPROXY_TUNNEL_PASSWORD');
  });

  test('读取亦优 HTTP 配置与安全刷新周期', () => {
    process.env.PROXY_PROVIDER = 'yiyou_http';
    process.env.YIYOU_HTTP_PROXY_API_URL = 'https://api.yiyouip.com/test';
    process.env.YIYOU_HTTP_PROXY_TTL_MS = '240000';

    const { config } = require('../src/utils/config');

    expect(config.proxy.yiyouHttp).toMatchObject({
      apiUrl: 'https://api.yiyouip.com/test',
      poolTtlMs: 240000,
    });
  });

  test('生产启用亦优 HTTP 时要求提取 API', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://integration.invalid/database';
    process.env.IMAP_HOST = 'imap.example.com';
    process.env.IMAP_USER = 'mailbox@example.com';
    process.env.IMAP_PASSWORD = 'synthetic-imap-password';
    process.env.PROXY_ENABLED = 'true';
    process.env.PROXY_PROVIDER = 'yiyou_http';
    delete process.env.YIYOU_HTTP_PROXY_API_URL;

    const { validateConfig } = require('../src/utils/config');

    expect(() => validateConfig()).toThrow('缺少必需的环境变量: YIYOU_HTTP_PROXY_API_URL');
  });
});
