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
});
