describe('config telegram environment variables', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_ENABLED;
    delete process.env.TELEGRAM_ALERT_ENABLED;
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
});
