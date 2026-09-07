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

    const { config, validateConfig } = require('../src/utils/config');

    expect(config.imap.allowedSenders).toEqual([]);
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

  test('代理启用时拒绝未知 Provider 配置', () => {
    process.env.PROXY_ENABLED = 'true';
    process.env.PROXY_PROVIDER = 'unknown';

    const { validateConfig } = require('../src/utils/config');

    expect(() => validateConfig()).toThrow('PROXY_PROVIDER 必须是 kdl_tunnel 或 kdl_private');
  });
});
