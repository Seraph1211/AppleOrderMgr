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
});
