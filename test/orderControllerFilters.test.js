/* eslint-disable camelcase */
const { Op } = require('sequelize');

jest.mock('../src/models', () => ({
  Order: {},
  AppleId: {},
  Recipient: {},
  EmailLog: {},
  OrderRefreshSchedule: {},
  OrderRefreshJob: {},
}));
jest.mock('../src/services/crawler/refreshJobService', () => ({}));
jest.mock('../src/services/crawler/refreshPolicy', () => ({
  getDisplayedFreshness: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { buildListFilters } = require('../src/controllers/orderController');

describe('订单列表付款状态筛选', () => {
  test('unknown 同时包含字面值、NULL 和空字符串', () => {
    const { where } = buildListFilters({ payment_status: 'unknown' });
    const alternatives = where[Op.and][0][Op.or];

    expect(alternatives).toEqual(
      expect.arrayContaining([
        { paymentStatus: 'unknown' },
        { paymentStatus: null },
        { paymentStatus: '' },
      ])
    );
  });

  test('已付款状态使用精确匹配', () => {
    const { where } = buildListFilters({ payment_status: 'paid' });

    expect(where).toEqual({ paymentStatus: 'paid' });
  });

  test('非法付款状态被拒绝', () => {
    expect(() => buildListFilters({ payment_status: 'pending' })).toThrow('payment_status 非法');
  });
});
