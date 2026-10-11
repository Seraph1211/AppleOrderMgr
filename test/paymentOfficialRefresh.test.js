jest.mock('../src/models', () => ({}));
jest.mock('../src/services/permissionService', () => ({}));
const {
  needsRefresh,
  automaticFrom,
  automaticEnabled,
} = require('../src/services/paymentOfficialRefreshService');

describe('付款官网自动核对停止条件', () => {
  test.each([
    'PROCESSING',
    'PREPARING_TO_SHIP',
    'SHIPPED',
    'DELIVERED',
    'READY_FOR_PICKUP',
    'PICKUP_READY',
    'PICKED_UP',
    'RETURN_STARTED',
    'RETURN_EXPIRED',
    'CANCELLED',
    'PAYMENT_EXPIRED_STORED_ORDER',
    'PROCESSING | SHIPPED',
  ])('%s 停止', officialRawStatus => {
    expect(needsRefresh({ officialRawStatus })).toBe(false);
  });
  test.each([
    null,
    '',
    'UNKNOWN',
    'PAYMENT_PENDING',
    'ORDER_PLACED',
    'SHIPPED | PAYMENT_PENDING',
    'PROCESSING | UNKNOWN',
    'RETURN_STARTED | PAYMENT_PENDING',
    'PROCESSING | NEW_STATE',
  ])('%s 继续', officialRawStatus => {
    expect(
      needsRefresh({
        officialRawStatus,
        orderDate: '2020-01-01T00:00:00Z',
        processingStatus: 'completed',
      })
    ).toBe(true);
  });
  test('邮件已付款优先停止', () => {
    expect(needsRefresh({ emailPaymentStatus: 'paid', officialRawStatus: 'PAYMENT_PENDING' })).toBe(
      false
    );
  });
  test('开发环境即使误配置也禁止自动官网请求', () => {
    const previous = {
      node: process.env.NODE_ENV,
      enabled: process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED,
      from: process.env.PAYMENT_OFFICIAL_REFRESH_FROM,
    };
    try {
      process.env.NODE_ENV = 'development';
      process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = 'true';
      process.env.PAYMENT_OFFICIAL_REFRESH_FROM = '2026-10-11T06:01:42Z';
      expect(automaticEnabled()).toBe(false);
      process.env.NODE_ENV = 'production';
      expect(automaticEnabled()).toBe(true);
      process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = 'false';
      expect(automaticEnabled()).toBe(false);
    } finally {
      process.env.NODE_ENV = previous.node;
      if (previous.from === undefined) delete process.env.PAYMENT_OFFICIAL_REFRESH_FROM;
      else process.env.PAYMENT_OFFICIAL_REFRESH_FROM = previous.from;
      if (previous.enabled === undefined) delete process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED;
      else process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = previous.enabled;
    }
  });
});

describe('自动核对持久入库起点', () => {
  test.each([
    '',
    'bad',
    '2026-10-11',
    '2026-02-30T06:01:42Z',
    '2026-13-01T06:01:42Z',
    '2026-10-11T24:01:42Z',
    '2026-10-11T06:01:42',
  ])('%s安全拒绝', value => {
    expect(automaticFrom(value)).toBeNull();
  });
  test.each(['2026-10-11T06:01:42Z', '2026-10-11T06:01:42.123Z', '2026-10-11T14:01:42+08:00'])(
    '%s接受ISO起点',
    value => {
      expect(automaticFrom(value)).toBeInstanceOf(Date);
    }
  );
  test('生产已启用但起点缺失或非法时保持关闭', () => {
    const previous = {
      node: process.env.NODE_ENV,
      enabled: process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED,
      from: process.env.PAYMENT_OFFICIAL_REFRESH_FROM,
    };
    try {
      process.env.NODE_ENV = 'production';
      process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = 'true';
      delete process.env.PAYMENT_OFFICIAL_REFRESH_FROM;
      expect(automaticEnabled()).toBe(false);
      process.env.PAYMENT_OFFICIAL_REFRESH_FROM = 'invalid';
      expect(automaticEnabled()).toBe(false);
      process.env.PAYMENT_OFFICIAL_REFRESH_FROM = '2026-10-11T06:01:42Z';
      expect(automaticEnabled()).toBe(true);
    } finally {
      process.env.NODE_ENV = previous.node;
      if (previous.enabled === undefined) delete process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED;
      else process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED = previous.enabled;
      if (previous.from === undefined) delete process.env.PAYMENT_OFFICIAL_REFRESH_FROM;
      else process.env.PAYMENT_OFFICIAL_REFRESH_FROM = previous.from;
    }
  });
});
