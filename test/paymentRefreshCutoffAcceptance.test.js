jest.mock('../src/models', () => ({}));
jest.mock('../src/services/permissionService', () => ({}));
const service = require('../src/services/paymentOfficialRefreshService');

describe('付款自动刷新时间范围独立验收', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });
  test.each([undefined, '', 'invalid', '2026-10-11', '2026-02-30T00:00:00Z'])(
    '应该拒绝缺失或非法ISO起点 %s',
    value => {
      if (value === undefined) delete process.env.PAYMENT_OFFICIAL_REFRESH_FROM;
      else process.env.PAYMENT_OFFICIAL_REFRESH_FROM = value;
      process.env.NODE_ENV = 'production';
      process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = 'true';
      expect(service.automaticFrom()).toBeNull();
      expect(service.automaticEnabled()).toBe(false);
    }
  );
  test.each(['2026-10-11T06:05:00Z', '2026-10-11T14:05:00+08:00', '2026-10-11T06:05:00.000Z'])(
    '应该接受明确ISO起点 %s',
    value => {
      process.env.NODE_ENV = 'production';
      process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = 'true';
      process.env.PAYMENT_OFFICIAL_REFRESH_FROM = value;
      expect(service.automaticFrom().toISOString()).toBe('2026-10-11T06:05:00.000Z');
      expect(service.automaticEnabled()).toBe(true);
    }
  );
});
